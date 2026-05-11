"use strict";
// v5/bot.js — Telegram bot. Confirm-then-apply for every action.
// Onboarding is deterministic (no AI). Post-setup is single-intent AI.

const { Bot } = require("grammy");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const m = require("./model");
const { applyIntent } = require("./engine");
const { compute, heroLine, heroLineWithInsight, simulateSpend } = require("./view");
const { processMessage } = require("./pipeline");
const { M } = require("./messages");
const db = require("./db");

// translateErr — convert engine/validator errors to the user's language.
// Engine throws errors with .code set (engineDupBill, setupFirst, etc.);
// validator returns reject() with reason already translated. For raw
// errors without a code, fall back to e.message (English) — better than
// crashing or showing nothing. ALL user-facing catch sites should pass
// through this helper rather than dumping e.message directly.
function translateErr(e, lang) {
  if (!e) return "";
  if (e.code) {
    const translated = M(lang, e.code, e.params);
    if (translated && translated !== e.code) return translated;
  }
  return e.message || String(e);
}

// normalizeLang — accepts Telegram language_code values like "en-US",
// "ru-RU", "kk-KZ", "uk-UA" and reduces them to the UI language we
// support (EN or RU strings). Cyrillic-family languages → ru (best
// available; Russian is widely understood in this region). Everything
// else → en.
//
// Why broader than just "ru": users in the post-Soviet space often have
// Telegram set to their national language (Kazakh, Belarusian, Ukrainian,
// Uzbek, Kyrgyz, etc.) but speak Russian and need Russian UI. Mapping
// these to "en" was a real complaint — they got an English bot they
// couldn't read fluently.
function normalizeLang(code) {
  if (!code) return "en";
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  const cyrillicFamily = new Set([
    "ru", "uk", "be", "kk", "ky", "uz", "tg",
    "mn", "bg", "mk", "sr", "ba", "cv", "sah", "tt"
  ]);
  if (cyrillicFamily.has(c)) return "ru";
  return "en";
}

// defaultCurrencyForLocale — country-aware. Uses the FULL locale code
// (e.g. "ru-KZ", "en-GB") to pick the most likely currency for the
// user's country. Falls back to language-only mapping if no country
// specifier. Decouples currency from UI language — a Russian-speaker
// in Kazakhstan should see KZT ₸, not RUB ₽; an English-speaker in
// the UK should see GBP £, not USD $.
//
// This closes the six "wrong-currency" holes flagged by users:
//   - Russian speaker, Kazakh Telegram (kk-KZ) → was: USD; now: KZT
//   - Russian speaker, Belarusian Telegram (be-BY) → was: USD; now: BYN
//   - Ukrainian speaker (uk-UA) → was: USD; now: UAH
//   - English speaker in UK (en-GB) → was: USD; now: GBP
//   - English speaker in Australia (en-AU) → was: USD; now: AUD
//   - Russian speaker in Russia (ru-RU) → was: RUB ✓ (unchanged)
const _CURRENCY_BY_LOCALE = {
  // Country-specific (full code wins)
  "ru-by": { code: "BYN", symbol: "Br" },
  "ru-kz": { code: "KZT", symbol: "₸" },
  "ru-ua": { code: "UAH", symbol: "₴" },
  "ru-kg": { code: "KGS", symbol: "сом" },
  "ru-uz": { code: "UZS", symbol: "сўм" },
  "kk-kz": { code: "KZT", symbol: "₸" },
  "be-by": { code: "BYN", symbol: "Br" },
  "uk-ua": { code: "UAH", symbol: "₴" },
  "ky-kg": { code: "KGS", symbol: "сом" },
  "uz-uz": { code: "UZS", symbol: "сўм" },
  "en-gb": { code: "GBP", symbol: "£" },
  "en-au": { code: "AUD", symbol: "$" },
  "en-ca": { code: "CAD", symbol: "$" },
  "en-nz": { code: "NZD", symbol: "$" },
  "en-ie": { code: "EUR", symbol: "€" },
  "en-in": { code: "INR", symbol: "₹" },
  "fr-ca": { code: "CAD", symbol: "$" },
  "fr-ch": { code: "CHF", symbol: "Fr" },
  "de-ch": { code: "CHF", symbol: "Fr" },
  "it-ch": { code: "CHF", symbol: "Fr" },
  "pt-br": { code: "BRL", symbol: "R$" },
  "zh-tw": { code: "TWD", symbol: "NT$" },
  "zh-hk": { code: "HKD", symbol: "HK$" },
  // Language-only fallbacks (when no country in the code)
  "ru": { code: "RUB", symbol: "₽" },
  "en": { code: "USD", symbol: "$" },
  "kk": { code: "KZT", symbol: "₸" },
  "be": { code: "BYN", symbol: "Br" },
  "uk": { code: "UAH", symbol: "₴" },
  "ky": { code: "KGS", symbol: "сом" },
  "uz": { code: "UZS", symbol: "сўм" },
  "tg": { code: "TJS", symbol: "сом" },
  "mn": { code: "MNT", symbol: "₮" },
  "bg": { code: "BGN", symbol: "лв" },
  "fr": { code: "EUR", symbol: "€" },
  "de": { code: "EUR", symbol: "€" },
  "es": { code: "EUR", symbol: "€" },
  "it": { code: "EUR", symbol: "€" },
  "pt": { code: "EUR", symbol: "€" },
  "nl": { code: "EUR", symbol: "€" },
  "pl": { code: "PLN", symbol: "zł" },
  "tr": { code: "TRY", symbol: "₺" },
  "ja": { code: "JPY", symbol: "¥" },
  "ko": { code: "KRW", symbol: "₩" },
  "zh": { code: "CNY", symbol: "¥" },
  "th": { code: "THB", symbol: "฿" },
  "vi": { code: "VND", symbol: "₫" },
  "id": { code: "IDR", symbol: "Rp" },
  "hi": { code: "INR", symbol: "₹" },
};
function defaultCurrencyForLocale(code) {
  if (!code) return { code: "USD", symbol: "$" };
  const c = String(code).toLowerCase().replace("_", "-");
  if (_CURRENCY_BY_LOCALE[c]) return _CURRENCY_BY_LOCALE[c];
  const baseLang = c.split("-")[0];
  if (_CURRENCY_BY_LOCALE[baseLang]) return _CURRENCY_BY_LOCALE[baseLang];
  return { code: "USD", symbol: "$" };
}
// Back-compat for code that still calls defaultCurrencyForLang.
// Internal use: prefer defaultCurrencyForLocale with the raw code.
function defaultCurrencyForLang(lang) {
  return defaultCurrencyForLocale(lang);
}

// hasBrainDumpExtras — heuristic: does the message contain content beyond
// a simple balance + payday? Triggers post-onboarding AI extraction so
// items like "rent 1400 due 1st", "spent 50 on groceries", "got paid"
// don't get silently dropped.
//
// Trigger if the message is reasonably long (> 8 words) AND contains
// trigger keywords like rent/bill/spent/paid/got/spotify/insurance/etc.
const BRAIN_DUMP_TRIGGERS = /\b(rent|bill|insurance|spotify|netflix|gym|phone|internet|mortgage|loan|subscription|spent|spend|paid|paying|got|received|paycheck|bought|coffee|grocer|food|delivery|uber|gas|petrol|due\b)/i;
function hasBrainDumpExtras(text) {
  if (!text || typeof text !== "string") return false;
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 6) return false;
  return BRAIN_DUMP_TRIGGERS.test(text);
}

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
if (process.env.BOT_TOKEN && process.env.BOT_TOKEN !== BOT_TOKEN) {
  console.warn("[v5] BOT_TOKEN had whitespace — trimmed");
}
const bot = BOT_TOKEN ? new Bot(BOT_TOKEN) : null;
// Lazy OpenAI client — only instantiated on first photo-OCR call.
// Tests can require this module without OPENAI_API_KEY set; the photo
// handler is the only path that touches it, and tests don't drive it.
let _openai = null;
function openaiClient() {
  if (_openai) return _openai;
  _openai = new OpenAI();
  return _openai;
}

// ── PENDING CONFIRMATIONS ─────────────────────────
// PERSISTED to state.pendingTokens — survives Railway redeploys.
// (Previous in-memory Map was wiped on every restart, causing
// "That confirm has expired" within seconds of any deploy. AAA fix.)
//
// Each entry: { token, intents: [...], expires: ts }.
// The state save happens in the caller's existing lock+save flow.
const PENDING_TTL_MS = 30 * 60 * 1000;
const PENDING_MAX = 20; // cap to prevent runaway accumulation per user

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// setPending mutates state.pendingTokens. Caller saves state.
// Accepts a single intent OR array of intents (brain-dump).
function setPending(state, intentOrArray) {
  const intents = Array.isArray(intentOrArray) ? intentOrArray : [intentOrArray];
  const token = makeToken();
  if (!Array.isArray(state.pendingTokens)) state.pendingTokens = [];
  // Sweep expired before pushing.
  const now = Date.now();
  state.pendingTokens = state.pendingTokens.filter(p => p && p.expires > now);
  state.pendingTokens.push({ token, intents, expires: now + PENDING_TTL_MS });
  if (state.pendingTokens.length > PENDING_MAX) {
    state.pendingTokens = state.pendingTokens.slice(-PENDING_MAX);
  }
  return token;
}

// setPendingPair — two linked pending entries, used by commitment_choice.
// The user picks ONE of two paths (today vs commitment). When either is
// taken (yes/no), the OTHER is auto-cleared so a delayed tap on the
// abandoned path doesn't double-apply.
function setPendingPair(state, intentsA, intentsB) {
  const tokenA = makeToken();
  const tokenB = makeToken();
  if (!Array.isArray(state.pendingTokens)) state.pendingTokens = [];
  const now = Date.now();
  state.pendingTokens = state.pendingTokens.filter(p => p && p.expires > now);
  state.pendingTokens.push({
    token: tokenA, intents: Array.isArray(intentsA) ? intentsA : [intentsA],
    pairedToken: tokenB, expires: now + PENDING_TTL_MS,
  });
  state.pendingTokens.push({
    token: tokenB, intents: Array.isArray(intentsB) ? intentsB : [intentsB],
    pairedToken: tokenA, expires: now + PENDING_TTL_MS,
  });
  if (state.pendingTokens.length > PENDING_MAX) {
    state.pendingTokens = state.pendingTokens.slice(-PENDING_MAX);
  }
  return [tokenA, tokenB];
}

// takePending pops the entry from state.pendingTokens (mutates state).
// Returns the entry or null. Caller saves state.
//
// Paired-token sweep: if the entry has a `pairedToken`, the partner is
// ALSO removed (so the abandoned half of a commitment_choice card
// can't be tapped 30s later and silently double-apply the spend).
function takePending(state, token) {
  if (!Array.isArray(state.pendingTokens) || state.pendingTokens.length === 0) return null;
  const idx = state.pendingTokens.findIndex(p => p && p.token === token);
  if (idx === -1) return null;
  const entry = state.pendingTokens[idx];
  if (entry.expires < Date.now()) {
    state.pendingTokens.splice(idx, 1);
    return null;
  }
  state.pendingTokens.splice(idx, 1);
  // Sweep the linked partner if present.
  if (entry.pairedToken) {
    const pIdx = state.pendingTokens.findIndex(p => p && p.token === entry.pairedToken);
    if (pIdx !== -1) state.pendingTokens.splice(pIdx, 1);
  }
  return entry;
}

// ── CONFIRM CARD ──────────────────────────────────
// confirmKeyboard — per-intent button labels.
//
// Old version used generic "Yes / Cancel" everywhere. That worked for
// most cases but broke on the boundary between confirm-cards and
// question-cards: when the AI replied with a clarifying question
// ("how long?") the generic Yes / Cancel left users wondering whether
// "Yes" meant "yes confirm the action" or "yes the answer to your
// question is yes." Per-intent verbs ("Reserve", "Log it", "Update")
// remove the ambiguity AND signal what'll happen on tap — AAA polish.
//
// The labels live in messages.js (EN + RU). `intent` is the validated
// intent the confirm card represents; the function reads .kind +
// .params.recurrence to pick the right verb (add_bill 'once' → Reserve,
// monthly → Add bill).
function buttonLabelsFor(intent, lang) {
  const kind = intent && intent.kind;
  const params = (intent && intent.params) || {};
  const ru = lang === "ru" ? "ru" : "en";
  // Default — generic confirm. Used only for unrecognized kinds.
  let yesCode = "btnConfirm";
  switch (kind) {
    case "add_bill": {
      // Three flavors:
      //   kind:"savings" → "Save" button (self-reservation)
      //   recurrence:"once" → "Reserve" (one-time future commitment)
      //   recurring → "Add bill" (regular obligation)
      if (params.kind === "savings") {
        yesCode = "btnSaveFor";
      } else {
        const isOnce = !params.recurrence || params.recurrence === "once";
        yesCode = isOnce ? "btnReserve" : "btnAddBill";
      }
      break;
    }
    case "add_income":          yesCode = "btnAddIncome";     break;
    case "remove_income":       yesCode = "btnRemoveIncome";  break;
    case "remove_bill":         yesCode = "btnRemoveBill";    break;
    case "record_spend":        yesCode = "btnLogSpend";      break;
    case "record_income":       yesCode = "btnLogIncome";     break;
    case "adjust_balance":      yesCode = "btnUpdateBalance"; break;
    case "update_payday":       yesCode = "btnUpdatePayday";  break;
    case "undo_last":           yesCode = "btnUndo";          break;
    case "delete_transaction":  yesCode = "btnDelete";        break;
    case "reset":               yesCode = "btnReset";         break;
    default:                    yesCode = "btnConfirm";       break;
  }
  return { yes: M(ru, yesCode), no: M(ru, "btnCancel") };
}

function confirmKeyboard(token, lang, intent) {
  const { yes, no } = buttonLabelsFor(intent, lang);
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: yes, callback_data: "yes:" + token },
        { text: no, callback_data: "no:" + token },
      ]],
    },
  };
}

// batchConfirmKeyboard — used for do_batch (multi-intent brain dumps).
// Labels show the count ("Add all 3" / "Yes, all 3" RU) so the user
// sees how many actions they're confirming with one tap.
function batchConfirmKeyboard(token, lang, count) {
  const ru = lang === "ru";
  const yesLabel = ru ? "Да, всё (" + count + ")" : "Yes, all " + count;
  const noLabel = M(ru ? "ru" : "en", "btnCancel");
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: yesLabel, callback_data: "yes:" + token },
        { text: noLabel,  callback_data: "no:"  + token },
      ]],
    },
  };
}

// undoKeyboard — generates the "Undo X" button shown after an applied
// intent. The label MUST say what it'll undo (else users tap it as a
// generic "back" button and nuke real work — see persona test 0003.4
// where Mike, Carol, and Sam all lost confirmed bills via accidental
// undo). The label is derived from the most-recent applied intent.
function undoKeyboard(eventId, lang, lastIntent) {
  const undoWord = lang === "ru" ? "Отменить" : "Undo";
  let label = undoWord;
  if (lastIntent && lastIntent.kind) {
    const desc = describeUndoTarget(lastIntent, lang);
    if (desc) label = undoWord + ": " + desc;
  }
  // Telegram inline-button text caps around 64 chars on phones; keep it tight.
  if (label.length > 60) label = label.slice(0, 57) + "…";
  return {
    reply_markup: {
      inline_keyboard: [[{ text: label, callback_data: "undo:" + eventId }]],
    },
  };
}

// describeUndoTarget — short noun-phrase for the undo label. Doesn't
// include amounts/dates — too long. Just kind + name.
function describeUndoTarget(intent, lang) {
  const p = intent.params || {};
  const ru = lang === "ru";
  switch (intent.kind) {
    case "adjust_balance":  return ru ? "коррекция баланса" : "balance change";
    case "add_bill":        return (ru ? "счёт " : "bill ") + (p.name || "");
    case "remove_bill":     return (ru ? "удаление " : "remove ") + (p.name || "");
    case "record_spend":    return (ru ? "трата " : "spend ") + (p.note || "");
    case "record_income":   return (ru ? "доход " : "income ") + (p.note || "");
    case "update_payday":   return ru ? "изменение зарплаты" : "payday change";
    case "reset":           return ru ? "сброс" : "reset";
    default:                return "";
  }
}

// ── INTENT FORMATTING ─────────────────────────────
// Turn a validated intent into a one-line summary for the confirm card.
// describeBackdate — render a friendly date suffix for the confirm card
// when a record_spend / record_income is for a past day. Today returns
// empty string (silent — that's the common case). Yesterday → "· yesterday".
// 2-7 days back → "· N days ago". Older → "· May 1" (date itself).
//
// The user must SEE the resolved date before confirming so they catch
// AI date-parsing mistakes (e.g. "last Tuesday" parsed as wrong week).
function describeBackdate(dateStr, state, lang) {
  if (!dateStr) return "";
  const today = m.today((state && state.timezone) || "UTC");
  if (dateStr === today) return "";
  const days = m.daysBetween(dateStr, today); // positive = past
  const ru = lang === "ru";
  if (days === 1) return ru ? " · вчера" : " · yesterday";
  if (days >= 2 && days <= 7) return ru ? " · " + days + " дн назад" : " · " + days + " days ago";
  // Older or future (shouldn't happen post-validation): show the raw date.
  // Friendly long-form like "May 1" reads better than "2026-05-01".
  try {
    const dt = new Date(dateStr + "T12:00:00Z");
    const friendly = dt.toLocaleDateString(ru ? "ru-RU" : "en-US", { month: "short", day: "numeric" });
    return " · " + friendly;
  } catch {
    return " · " + dateStr;
  }
}

function describeIntent(intent, state) {
  const p = intent.params || {};
  const sym = state.currencySymbol || "$";
  const lang = state.language === "ru" ? "ru" : "en";
  const M = (c) => m.toMoney(c, sym);
  const E = m.escapeMd;

  switch (intent.kind) {
    case "adjust_balance":
      return lang === "ru"
        ? "Поправить баланс → " + M(p.newBalanceCents)
        : "Set balance to " + M(p.newBalanceCents);
    case "add_bill": {
      // Unified commitment intent — verb adapts to shape:
      //   kind:"savings" → "Save for X" (self-reservation)
      //   recurrence:"once" → "Set aside" (one-time future commitment)
      //   recurring → "Add bill" (regular obligation)
      const isOnce = p.recurrence === "once" || !p.recurrence;
      const isSavings = p.kind === "savings";
      const ru = lang === "ru";
      let verb;
      if (isSavings) {
        verb = ru ? "Откладывать на" : "Save for";
      } else if (isOnce) {
        verb = ru ? "Отложить" : "Set aside";
      } else {
        verb = ru ? "Добавить счёт" : "Add bill";
      }
      const recurrenceTag = isOnce
        ? ""
        : " · " + p.recurrence;
      // Pace impact line — compute by simulating the add and showing
      // the daily-pace delta. THIS is the inline afford-check. User
      // sees the cost-per-day before tapping Yes. Failsafe AAA.
      let paceLine = "";
      try {
        const sim = require("./view").simulateAddBill(state, p);
        if (sim && sim.delta && Number.isFinite(sim.delta.dailyPaceCents)) {
          const dropCents = -sim.delta.dailyPaceCents; // positive number = how much pace drops
          if (dropCents > 0) {
            const dropFmt = m.toShort(dropCents, sym);
            const projFmt = m.toShort(sim.projected.dailyPaceCents, sym);
            paceLine = ru
              ? "\n_Темп: −" + dropFmt + "/день → " + projFmt + "/день_"
              : "\n_Pace: −" + dropFmt + "/day → " + projFmt + "/day_";
            // Warn if projection puts user in tight or over state.
            if (sim.projected.status === "tight") {
              paceLine += ru ? " ⚠️ впритык" : " ⚠️ tight";
            } else if (sim.projected.status === "over") {
              paceLine = ru
                ? "\n_⚠️ Это превысит твой бюджет — оставит дефицит_"
                : "\n_⚠️ This would put you over — would leave a deficit_";
            }
          }
        }
      } catch { /* never block the confirm card on a math hiccup */ }
      // Foreign-currency bill: show both ("€200 ≈ $216") like record_spend.
      // Without this the user types "200 euro for friend" and the confirm
      // card silently shows only $216 — they can't verify the conversion.
      const isForeign = p.originalCurrency
        && Number.isFinite(p.originalAmount)
        && p.originalAmount > 0;
      let amountPhrase;
      if (isForeign) {
        const ccy = require("./currency");
        const fromSubunits = ccy.spokenToSubunits(p.originalAmount, p.originalCurrency);
        amountPhrase = ccy.fmt(fromSubunits, p.originalCurrency) + " ≈ " + M(p.amountCents);
      } else {
        amountPhrase = M(p.amountCents);
      }
      const head = verb + " *" + E(p.name) + "* — " + amountPhrase + " · " + p.dueDate + recurrenceTag;
      return head + paceLine;
    }
    case "remove_bill":
      return lang === "ru"
        ? "Удалить счёт *" + E(p.name) + "*"
        : "Remove bill *" + E(p.name) + "*";
    case "update_bill": {
      // Render the diff — what's changing on this bill. Multiple field
      // changes get joined with " · ".
      const parts = [];
      if (p.amountCents != null) parts.push(M(p.amountCents));
      if (p.dueDate != null) parts.push((lang === "ru" ? "к " : "due ") + p.dueDate);
      if (p.recurrence != null) parts.push(p.recurrence);
      const delta = parts.join(" · ");
      return lang === "ru"
        ? "Изменить *" + E(p.name) + "* → " + delta
        : "Update *" + E(p.name) + "* → " + delta;
    }
    case "record_spend": {
      // Foreign-currency spend: show both ("₫200,000 ≈ $8.00").
      const isForeign = p.originalCurrency
        && Number.isFinite(p.originalAmount)
        && p.originalAmount > 0;
      let amountPhrase;
      if (isForeign) {
        const ccy = require("./currency");
        const fromSubunits = ccy.spokenToSubunits(p.originalAmount, p.originalCurrency);
        amountPhrase = ccy.fmt(fromSubunits, p.originalCurrency) + " ≈ " + M(p.amountCents);
      } else {
        amountPhrase = M(p.amountCents);
      }
      // Title prefers vendor (the entity) over raw note. Falls back to
      // note if no vendor. Both lowercase OK in note ("coffee at lighthouse")
      // — vendor capitalizes the entity.
      const titleParts = [];
      if (p.vendor) titleParts.push(E(p.vendor));
      if (p.note && p.note !== p.vendor) titleParts.push(E(p.note));
      const title = titleParts.length > 0 ? " · " + titleParts.join(" — ") : "";
      // Category as a small badge after the title.
      const catBadge = p.category && p.category !== "other" ? " #" + p.category : "";
      // Backdate badge — surface the EVENT date when it's not today
      // so the user catches AI date-parsing mistakes BEFORE confirming.
      // Today = silent (default); past date = explicit ("· yesterday" /
      // "· May 1" / "· 3 days ago").
      const dateBadge = describeBackdate(p.date, state, lang);
      return lang === "ru"
        ? "Расход " + amountPhrase + title + catBadge + dateBadge
        : "Spend " + amountPhrase + title + catBadge + dateBadge;
    }
    case "record_income": {
      const dateBadge = describeBackdate(p.date, state, lang);
      return lang === "ru"
        ? "Доход " + M(p.amountCents) + (p.note ? " · " + E(p.note) : "") + dateBadge
        : "Income " + M(p.amountCents) + (p.note ? " · " + E(p.note) : "") + dateBadge;
    }
    case "add_income": {
      // Future positive cashflow — the symmetric twin of add_bill.
      // "Tracking: Acme — $4,000 · expected May 25"
      const ru2 = lang === "ru";
      const verb = ru2 ? "Жду доход" : "Tracking income";
      const recTag = p.recurrence && p.recurrence !== "once" ? " · " + p.recurrence : "";
      return verb + " *" + E(p.name || (ru2 ? "доход" : "income")) + "* — " + M(p.amountCents) +
        " · " + (ru2 ? "к " : "expected ") + p.expectedDate + recTag;
    }
    case "remove_income":
      return lang === "ru"
        ? "Отменить ожидаемый доход *" + E(p.name || p.id || "") + "*"
        : "Cancel expected income *" + E(p.name || p.id || "") + "*";
    case "update_payday":
      return lang === "ru"
        ? "Зарплата → " + (p.payday || "?") + (p.payFrequency ? " (" + p.payFrequency + ")" : "")
        : "Payday → " + (p.payday || "?") + (p.payFrequency ? " (" + p.payFrequency + ")" : "");
    case "undo_last":
      return lang === "ru" ? "Отменить последнее действие" : "Undo last action";
    case "delete_transaction": {
      // Confirm card MUST show distinguishing details so user can spot
      // wrong-target before tapping Yes. Pull the target tx from state
      // and render its salient fields.
      const id = String(p.id || "").trim();
      const tx = (state.transactions || []).find(t => t.id === id);
      if (!tx) {
        return lang === "ru" ? "Удалить трату — не найдено" : "Delete transaction — not found";
      }
      const ccy = require("./currency");
      const isForeign = tx.originalCurrency && Number.isFinite(tx.originalAmount) && tx.originalAmount > 0;
      const amtPhrase = isForeign
        ? ccy.fmt(ccy.spokenToSubunits(tx.originalAmount, tx.originalCurrency), tx.originalCurrency) + " ≈ " + M(Math.abs(tx.amountCents))
        : M(Math.abs(tx.amountCents));
      const labelParts = [];
      if (tx.vendor) labelParts.push(E(tx.vendor));
      if (tx.note && tx.note !== tx.vendor) labelParts.push(E(tx.note));
      const label = labelParts.length > 0 ? " · " + labelParts.join(" — ") : "";
      const dateStr = tx.date ? " · " + tx.date : "";
      return lang === "ru"
        ? "Удалить: " + amtPhrase + label + dateStr
        : "Delete: " + amtPhrase + label + dateStr;
    }
    case "reset":
      return lang === "ru" ? "Полный сброс — все данные удалятся" : "Full reset — wipes all data";
    default:
      return intent.kind;
  }
}

// ── SAFE TELEGRAM SEND ────────────────────────────
async function safeReply(ctx, text, options) {
  try {
    return await ctx.reply(text, options || {});
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/can't parse|parse_mode/i.test(msg) && options && options.parse_mode) {
      const fallback = Object.assign({}, options);
      delete fallback.parse_mode;
      try { return await ctx.reply(text, fallback); }
      catch (e2) { console.error("[v5 safeReply retry]", e2.message); }
    } else {
      console.error("[v5 safeReply]", msg);
    }
    return null;
  }
}

// ── REPLY KEYBOARD (persistent quick-capture buttons) ─────────
// Four buttons at the bottom of chat — always available, low-friction:
//   [+ Spend]  [+ Bill]  [Afford?]  [Open app]
//
// Tap a button → bot enters a tiny GUIDED FLOW: asks one question,
// user types the answer, bot parses with context. Two messages from
// tap to logged. The most-common actions get the fewest taps.
//
// The keyboard is set on the post-onboarding "all set" message and
// stays visible across the conversation. Reply keyboards persist —
// no need to resend.
const REPLY_BUTTON_LABELS = {
  en: { spend: "+ Spend", bill: "+ Bill", afford: "Afford?", app: "Open app" },
  ru: { spend: "+ Расход", bill: "+ Счёт", afford: "Могу ли?", app: "Открыть" },
};
function mainKeyboard(lang) {
  const L = (lang === "ru") ? "ru" : "en";
  const lbl = REPLY_BUTTON_LABELS[L];
  return {
    keyboard: [
      [{ text: lbl.spend }, { text: lbl.bill }],
      [{ text: lbl.afford }, { text: lbl.app }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
// Reverse-lookup: incoming message text → button kind (or null).
function detectReplyButton(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim();
  for (const L of ["en", "ru"]) {
    const lbl = REPLY_BUTTON_LABELS[L];
    if (t === lbl.spend) return "spend";
    if (t === lbl.bill) return "bill";
    if (t === lbl.afford) return "afford";
    if (t === lbl.app) return "app";
  }
  return null;
}
// Localized guided-flow prompts.
function guidedPromptFor(kind, lang) {
  const ru = lang === "ru";
  switch (kind) {
    case "spend":  return ru ? "Сколько, на что? _(пример: «5 кофе»)_" : "How much, what for? _(e.g. \"5 coffee\")_";
    case "bill":   return ru ? "Название счёта, сумма, когда платить? _(пример: «аренда 1400 1-го числа»)_" : "Bill name, amount, when due? _(e.g. \"rent 1400 monthly the 1st\")_";
    case "afford": return ru ? "Сколько и на что? _(пример: «200 куртка»)_" : "How much for what? _(e.g. \"200 jacket\")_";
    default: return ru ? "Что сделать?" : "What's the action?";
  }
}
// Transform a guided reply into a natural-language form the AI parses
// cleanly. The hint kind tells us how to prefix.
function applyGuidedHint(text, kind) {
  if (!text || !kind) return text;
  const t = String(text).trim();
  // If the user already wrote a fully-qualified sentence (rare), keep it.
  // Otherwise prefix with a verb the AI knows.
  switch (kind) {
    case "spend":
      if (/^(spent|i\s+spent|got\s+a|paid|потратил|купил|оплатил)/i.test(t)) return t;
      return "spent " + t;
    case "afford":
      if (/^(can\s+i\s+afford|if\s+i|могу\s+ли|если\s+потрачу)/i.test(t)) return t;
      return "can I afford " + t;
    case "bill":
      // Bills are usually self-descriptive ("rent 1400 monthly"); no prefix needed.
      return t;
    default:
      return t;
  }
}

async function safeEdit(ctx, text, options) {
  try {
    return await ctx.editMessageText(text, options || {});
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/not modified/i.test(msg)) return null;
    if (/can't parse|parse_mode/i.test(msg) && options && options.parse_mode) {
      const fallback = Object.assign({}, options);
      delete fallback.parse_mode;
      try { return await ctx.editMessageText(text, fallback); }
      catch (e2) { console.error("[v5 safeEdit retry]", e2.message); }
    }
    return null;
  }
}

// Last-AI-output ring buffer per user. Powers `/debug` so we can
// inspect what the AI actually returned without bothering the user.
const { recordAiRaw, getAiRaw, getWarnings } = require("./ai-debug");

// ── PROCESS A USER MESSAGE ────────────────────────
// `options` is harness-only — `_aiCall` injects an alternate AI backend
// for tests. Production callers don't pass it.
async function processText(prisma, ctx, telegramId, text, options) {
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  await ctx.replyWithChatAction("typing").catch(() => {});

  // Pass userId so ai.js can record raw output for /debug.
  options = Object.assign({}, options || {}, { _debugUserId: telegramId });

  // Set to true inside the lock if we need to tail-process the same
  // message AFTER releasing the lock (brain-dump capture). Defined
  // outside the lock callback so we can read it after it returns.
  let runBrainDumpTail = false;

  await db.withUserLock(u.id, async () => {
    let state = await db.loadState(prisma, u.id);

    // Detect language + currency from Telegram's client locale on the
    // first turn (virgin user — no setup, no transactions, no events).
    // After that, the user's language/currency are locked unless they
    // explicitly switch via /language or /currency commands.
    //
    // CRITICAL: language and currency are decoupled now.
    //   - Language: cyrillic-family locale codes → "ru" UI; else "en"
    //   - Currency: FULL locale code → country-aware mapping
    //     (e.g. "ru-KZ" → KZT, "en-GB" → GBP, "kk-KZ" → KZT)
    //
    // This closes the "Russian speaker in Kazakhstan got USD" complaint.
    const tgLang = ctx.from && ctx.from.language_code;
    const isVirgin = !state.setup && (!state.transactions || state.transactions.length === 0)
      && (!state.events || state.events.length === 0);
    if (isVirgin && tgLang) {
      const newLang = normalizeLang(tgLang);
      const newCcy = defaultCurrencyForLocale(tgLang);
      let changed = false;
      if (state.language !== newLang) { state.language = newLang; changed = true; }
      if (state.currency !== newCcy.code) {
        state.currency = newCcy.code;
        state.currencySymbol = newCcy.symbol;
        changed = true;
      }
      if (changed) await db.saveState(prisma, u.id, state);
    }

    const lang = state.language === "ru" ? "ru" : "en";
    const history = await db.loadHistory(prisma, u.id);

    // ── REPLY-KEYBOARD BUTTON TAP ──
    // The persistent keyboard sends button LABELS as plain text. If we
    // see one, intercept BEFORE the AI gets it: set a guided-prompt
    // marker on state, send the one-question prompt, wait for next msg.
    const buttonKind = state.setup ? detectReplyButton(text) : null;
    if (buttonKind === "app") {
      // Open app — same as /app command.
      const url = process.env.MINIAPP_URL;
      if (!url) { await safeReply(ctx, M(lang, "miniAppNotConfigured")); return; }
      await safeReply(ctx, M(lang, "miniAppOpen"), {
        reply_markup: { inline_keyboard: [[{ text: lang === "ru" ? "Открыть" : "Open", web_app: { url } }]] },
      });
      return;
    }
    if (buttonKind === "spend" || buttonKind === "bill" || buttonKind === "afford") {
      // Set the guided-prompt marker. Expires after 5 minutes so an
      // abandoned flow doesn't trap the next message forever.
      state.guidedPrompt = { kind: buttonKind, started: Date.now() };
      await db.saveState(prisma, u.id, state);
      await safeReply(ctx, "_" + m.escapeMd(guidedPromptFor(buttonKind, lang)) + "_", { parse_mode: "Markdown" });
      return;
    }

    // ── GUIDED-PROMPT REPLY ──
    // If user is mid-guided-flow (tapped a button last turn), transform
    // their reply into a prefixed sentence the AI parses naturally.
    // 5 min expiry — if they ignored the prompt and typed something
    // unrelated, fall through to normal processing.
    let processedText = text;
    if (state.guidedPrompt && Date.now() - (state.guidedPrompt.started || 0) < 5 * 60 * 1000) {
      processedText = applyGuidedHint(text, state.guidedPrompt.kind);
      state.guidedPrompt = null;
      await db.saveState(prisma, u.id, state);
    } else if (state.guidedPrompt) {
      // Stale — clean up.
      state.guidedPrompt = null;
      await db.saveState(prisma, u.id, state);
    }

    // Persist user message into history.
    await db.appendHistory(prisma, u.id, "user", text);

    const result = await processMessage(state, processedText, history, options);

    // ── ONBOARDING ───────────────────────────────
    if (result.kind === "onboarding") {
      // Apply setup_account immediately if onboarding emitted one.
      if (result.intent) {
        try {
          state = applyIntent(state, result.intent).state;
        } catch (e) {
          console.error("[v5 onboarding apply]", e.message);
          await safeReply(ctx, lang === "ru" ? "Что-то пошло не так — попробуй ещё раз?" : "Something went wrong — try again?");
          return;
        }
      }
      // Update / clear draft.
      if (result.draft) {
        state.onboardingDraft = Object.assign({}, state.onboardingDraft || {}, result.draft);
      }
      if (result.clearDraft) {
        state.onboardingDraft = null;
      }
      // Save if anything changed.
      if (result.intent || result.draft || result.clearDraft) {
        await db.saveState(prisma, u.id, state);
      }

      // Reply text + hero on completion.
      let reply = result.reply;
      if (result.done && state.setup) {
        reply += "\n\n" + heroLineWithInsight(state, lang);
      }
      await db.appendHistory(prisma, u.id, "assistant", reply);
      // Attach the persistent reply keyboard on the FINAL onboarding
      // message — once it's set, Telegram remembers it across the
      // conversation. The user gets quick-capture buttons forever.
      const replyOpts = { parse_mode: "Markdown" };
      if (result.done && state.setup) {
        replyOpts.reply_markup = mainKeyboard(lang);
      }
      await safeReply(ctx, reply, replyOpts);

      // ── BRAIN-DUMP CAPTURE ────────────────────────
      // If onboarding just completed AND the original message has bill /
      // spend / income content beyond balance + payday, signal that we
      // should re-route the same message through the AI AFTER releasing
      // this user's lock. (Re-entering the lock would deadlock.)
      if (result.done && state.setup && hasBrainDumpExtras(text)) {
        runBrainDumpTail = true;
      }
      return;
    }

    // ── TALK ─────────────────────────────────────
    if (result.kind === "talk") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      await safeReply(ctx, result.message, { parse_mode: "Markdown" });
      return;
    }

    // ── DECISION (can-I-afford simulate) ─────────
    if (result.kind === "decision") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      const lines = [];
      if (result.message) lines.push(result.message);
      const sim = result.simulate;
      if (sim) {
        const M = (c) => m.toMoney(c, state.currencySymbol);
        // Show DISPOSABLE (= balance − bills set aside), not raw balance.
        // Reasoning: this is a "can I afford?" question, so the
        // meaningful answer is "what's left of my SPENDING POOL after
        // this purchase?" — not "what's my new bank-balance number?".
        // Bills are already reserved; subtracting from total balance
        // double-counts them in the user's mental ledger. (Same brand
        // rule as the hero now: 'available', not 'in account'.)
        const projAvailable = M(sim.projected.disposableCents);
        const irregular = state.payFrequency === "irregular";
        if (sim.projected.status === "over") {
          // No: it'd put them over. Show the deficit AND raw balance
          // for context — in over-state, disposable is capped at 0
          // and isn't useful, but balance tells the user what's
          // physically in the account.
          const projBalance = M(sim.projected.balanceCents);
          lines.push(lang === "ru"
            ? "🔴 *Не стоит* — это даст " + M(sim.projected.deficitCents) + " дефицита. На счету останется " + projBalance + "."
            : "🔴 *Not really* — that'd put you " + M(sim.projected.deficitCents) + " over. You'd have " + projBalance + " in account.");
        } else if (sim.projected.status === "tight") {
          // Maybe: it's tight. Show what's left of the spending pool.
          const horizon = irregular
            ? (lang === "ru" ? " на месяц" : " for a month")
            : (lang === "ru" ? " на " + sim.projected.daysToPayday + " дн" : " for " + sim.projected.daysToPayday + " days");
          lines.push(lang === "ru"
            ? "🟡 *Впритык* — после этого " + projAvailable + " доступно, " + sim.projected.dailyPaceFormatted + "/день" + horizon + "."
            : "🟡 *Tight* — after that you'd have " + projAvailable + " available, " + sim.projected.dailyPaceFormatted + "/day" + horizon + ".");
        } else {
          // Yes: clear. Show after-available + new pace.
          lines.push(lang === "ru"
            ? "🟢 *Да, можно* — после этого " + projAvailable + " доступно, " + sim.projected.dailyPaceFormatted + "/день."
            : "🟢 *Yep, you're fine* — after that you'd have " + projAvailable + " available, " + sim.projected.dailyPaceFormatted + "/day.");
        }
      }
      // Offer "log it now" button. If the AI captured a note/vendor/
      // category from the afford-check ("can I afford 200 for a jacket?"
      // → note="jacket"), thread it into the log intent so the resulting
      // record_spend isn't a noteless ghost in history.
      const logParams = { amountCents: result.amountCents, note: result.note || "" };
      if (result.vendor) logParams.vendor = result.vendor;
      if (result.category) logParams.category = result.category;
      const logIntent = { kind: "record_spend", params: logParams };
      const token = setPending(state, logIntent);
      await db.saveState(prisma, u.id, state);
      // Decision flow buttons. If we have a note, the label can be
      // more specific: "Log jacket" beats "Log it" for clarity.
      const yesLabel = lang === "ru"
        ? (result.note ? "Записать «" + result.note + "»" : "Записать")
        : (result.note ? "Log it · " + result.note : "Log it");
      const noLabel = lang === "ru" ? "Не сейчас" : "Skip";
      await safeReply(ctx, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: yesLabel, callback_data: "yes:" + token },
            { text: noLabel, callback_data: "no:" + token },
          ]],
        },
      });
      return;
    }

    // ── COMMITMENT_CHOICE (big "for X" spend — 2-option card) ──
    // The pipeline detected a record_spend that looks like a planned
    // commitment ("$200 for friend's wedding"). Default record_spend
    // would eat today's daily allowance, which is wrong for one-time
    // commitments. Offer two paths:
    //
    //   [Spend today]                 — normal record_spend, eats daily
    //   [Commitment (won't eat daily)] — add_bill once + bill_payment,
    //                                    balance drops but pace stays
    //
    // Two paired pending tokens — picking one clears the other so a
    // delayed tap on the abandoned path can't double-apply.
    if (result.kind === "commitment_choice") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      const [tokenSpend, tokenCommit] = setPendingPair(state, result.spendIntent, result.commitmentBatch);
      await db.saveState(prisma, u.id, state);
      const card = describeIntent(result.spendIntent, state);
      const intro = result.message ? result.message + "\n\n" : "";
      const hint = M(lang, "commitmentHint");
      const labelSpend = M(lang, "btnCommitToday");
      const labelCommit = M(lang, "btnCommitPlanned");
      const labelCancel = M(lang, "btnCancel");
      await safeReply(ctx, intro + card + "\n\n_" + m.escapeMd(hint) + "_", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: labelSpend, callback_data: "yes:" + tokenSpend }],
            [{ text: labelCommit, callback_data: "yes:" + tokenCommit }],
            [{ text: labelCancel, callback_data: "no:" + tokenSpend }],
          ],
        },
      });
      return;
    }

    // ── CLARIFY (missing required field — ASK user, NO BUTTONS) ──
    // The validator returned a soft reject: the intent the AI proposed
    // is missing a required field (dueDate, name, amount). Reply with
    // a plain-text question and STOP — no confirm card, no token.
    //
    // The user's next message supplies the missing piece; AI re-parses
    // with the new info in conversation history and emits a complete
    // intent which then takes the normal `do` path.
    //
    // This fixes the user-reported bug: "200 euro budget for friend to
    // store" → AI asked "how long do you need it for?" wrapped in Log
    // it / Skip buttons. Now: just the question, no buttons. The
    // mechanism (button mismatch) is gone because clarify never wears
    // buttons by design.
    if (result.kind === "clarify") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      // Italic + no buttons — visually distinct from a confirm card.
      await safeReply(ctx, "_" + m.escapeMd(result.message) + "_", { parse_mode: "Markdown" });
      return;
    }

    // ── DO (validated intent) ────────────────────
    if (result.kind === "do") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      if (!result.verdict.ok) {
        // Hard reject — show the reason, no buttons. (Clarify is handled
        // above; anything reaching here is a structural failure: dup
        // bill, past date, spend > 2x balance, etc.)
        await safeReply(ctx, "_" + m.escapeMd(result.verdict.reason) + "_", { parse_mode: "Markdown" });
        return;
      }
      const token = setPending(state, result.intent);
      await db.saveState(prisma, u.id, state);
      const card = describeIntent(result.intent, state);
      const intro = result.message ? result.message + "\n\n" : "";
      // Per-intent button labels — "Reserve" on set-asides, "Add bill"
      // on recurring, "Log it" on spends, "Update" on balance. Removes
      // the "Yes means what?" ambiguity that the generic "Yes" carried.
      await safeReply(ctx, intro + card, {
        parse_mode: "Markdown",
        ...confirmKeyboard(token, lang, result.intent),
      });
      return;
    }

    // ── DO_BATCH (multi-intent brain dump) ───────
    if (result.kind === "do_batch") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      const okItems = result.items.filter(i => i.verdict.ok);
      const failItems = result.items.filter(i => !i.verdict.ok);
      if (okItems.length === 0) {
        // Nothing valid — show the rejections, no card.
        const lines = failItems.map(i => "_" + m.escapeMd(i.verdict.reason || "") + "_");
        await safeReply(ctx, lines.join("\n"), { parse_mode: "Markdown" });
        return;
      }
      // One combined card listing each valid action with a single Yes-all.
      const intents = okItems.map(i => i.intent);
      const token = setPending(state, intents);
      await db.saveState(prisma, u.id, state);
      const intro = lang === "ru" ? "*Хочу добавить:*" : "*I'll add:*";
      const numbered = intents.map((i, idx) => "  " + (idx + 1) + ". " + describeIntent(i, state));
      const skippedLines = failItems.length
        ? "\n\n" + (lang === "ru" ? "_Пропущено:_" : "_Skipped:_") + "\n" + failItems.map(i => "  • " + m.escapeMd(i.verdict.reason || "")).join("\n")
        : "";
      const message = (result.message ? result.message + "\n\n" : "") + intro + "\n" + numbered.join("\n") + skippedLines;
      await safeReply(ctx, message, {
        parse_mode: "Markdown",
        ...batchConfirmKeyboard(token, lang, intents.length),
      });
      return;
    }
  });

  // ── BRAIN-DUMP TAIL ──
  // Onboarding completed and the message had additional content (a bill,
  // a spend, etc.). Re-process the same message through the AI path now
  // that state.setup is true. This call is OUTSIDE the lock; it acquires
  // its own. Errors are logged but don't break the user's flow.
  if (runBrainDumpTail) {
    try {
      await processText(prisma, ctx, telegramId, text, options);
    } catch (e) {
      console.error("[v5 brain-dump tail]", e.message);
    }
  }
}

// ── COMMAND PROCESSORS (testable) ────────────────
// Each processCommand / processCallbackData function takes the prisma client,
// a ctx-like object, the telegram id, and a payload. It NEVER reads
// `ctx.from.id` directly — telegramId is passed in. This makes the harness
// able to drive every entry point with a mock ctx.

async function processCommand(prisma, ctx, telegramId, command, payload) {
  if (command === "start") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    // One-time cleanup: v4 builds pinned a hero status message via
    // pinChatMessage. v5 doesn't pin, but the v4 pin lingers in chats
    // because Telegram never auto-unpins. Unpin everything once on
    // first /start after upgrade. Best-effort, never blocks the user.
    if (!state.legacyPinCleared) {
      try {
        const chatId = ctx.chat ? ctx.chat.id : (ctx.from && ctx.from.id);
        if (chatId && ctx.api && typeof ctx.api.unpinAllChatMessages === "function") {
          await ctx.api.unpinAllChatMessages(chatId);
        }
      } catch (e) {
        // Ignore — pinning permission may be denied; cleanup is non-essential.
      }
      state.legacyPinCleared = true;
      state.pinnedMessageId = null; // wipe the v4 pointer too
      await db.saveState(prisma, u.id, state);
    }
    if (!state.setup) {
      await processText(prisma, ctx, telegramId, "/start");
    } else {
      // Re-attach the persistent reply keyboard on /start for users who
      // were onboarded before the keyboard existed (or who cleared it).
      await safeReply(ctx, heroLineWithInsight(state, lang), {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard(lang),
      });
    }
    return;
  }
  if (command === "help") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    // Beautiful sectioned help with brand voice. Three parts:
    //   1. The idea (one paragraph — what Spendkitty does and doesn't)
    //   2. How to talk to me (5 capability blocks with examples)
    //   3. The numbers + commands (what to glance at, what to type)
    //
    // Each section short. Examples in italic. Commands at the bottom.
    const helpText = lang === "ru"
      ? "🌱 *Spendkitty*\n\n" +
        "Я делаю одну вещь: каждый день показываю тебе одно число — *сколько можешь потратить сегодня*. Счета зарезервированы, до зарплаты посчитано. Без бюджетов и категорий.\n\n" +
        "*С чем ко мне можно прийти:*\n\n" +
        "💸 *Логировать траты* — просто скажи естественно:\n" +
        "  · _«5 на кофе»_\n" +
        "  · _«500 руб такси домой»_\n" +
        "  · _«вчера купил продукты на 1500»_\n" +
        "  · 📷 пришли фото чека — разберу сам\n\n" +
        "💰 *Доход — пришёл или ожидается:*\n" +
        "  · _«получил зарплату»_ / _«получил 3000»_\n" +
        "  · _«жду 4000 от Acme в пятницу»_ — учту заранее в твоём дневном числе\n\n" +
        "🧾 *Счета:*\n" +
        "  · _«аренда 50000 первого числа»_\n" +
        "  · _«телефон 800 ежемесячно»_\n" +
        "  · _«перенеси аренду на 15-е»_ — обновлю существующий счёт\n" +
        "  · _«оплатил аренду»_ — отмечу как оплаченный\n\n" +
        "🎯 *Откладывать на что-то:*\n" +
        "  · _«отложить 200 на поездку друга к пятнице»_\n" +
        "  · _«копить 100 в месяц на чрезвычайный фонд»_\n\n" +
        "❓ *Спрашивать «могу ли я?»:*\n" +
        "  · _«могу ли позволить 200?»_\n" +
        "  · _«если потрачу 60 на ужин?»_\n\n" +
        "🔢 *Что показывают цифры:*\n" +
        "  · *На сегодня* — сколько можно потратить ПРЯМО сейчас\n" +
        "  · *Дневной темп* — твой стабильный лимит на день\n" +
        "  · *Доступно* — баланс минус резервы под счета\n" +
        "  · *На счёте* — что реально в банке\n\n" +
        "⚡ *Команды:*\n" +
        "  /today — статус сейчас\n" +
        "  /bills — счета (одним нажатием оплатить)\n" +
        "  /undo — отменить последнее\n" +
        "  /app — открыть дашборд\n" +
        "  /language — переключить язык (en / ru)\n" +
        "  /currency — поменять валюту (RUB / USD / EUR / KZT…)\n" +
        "  /privacy — что я храню\n" +
        "  /export — выгрузить все данные (JSON)\n" +
        "  /reset — стереть всё\n\n" +
        "_«Математика готова. Ты просто тратишь.»_"
      : "🌱 *Spendkitty*\n\n" +
        "I do one thing: every day I tell you *one number — what you can spend today*. Bills are reserved. Days to payday are counted. No budgets, no categories, no homework.\n\n" +
        "*What you can tell me:*\n\n" +
        "💸 *Log a spend* — just say it naturally:\n" +
        "  · _\"5 on coffee\"_\n" +
        "  · _\"$50 dinner at Lighthouse\"_\n" +
        "  · _\"yesterday I forgot to log $80 groceries\"_\n" +
        "  · 📷 send a receipt photo — I'll read it\n\n" +
        "💰 *Income — landed or coming:*\n" +
        "  · _\"got paid\"_ / _\"got 3000 paycheck\"_\n" +
        "  · _\"expecting 4000 from Acme on friday\"_ — I'll work it into today's number\n\n" +
        "🧾 *Bills:*\n" +
        "  · _\"rent 1400 due the 1st\"_\n" +
        "  · _\"phone 80 monthly\"_\n" +
        "  · _\"move rent to the 15th\"_ — I'll update the existing one\n" +
        "  · _\"paid the rent\"_ — I'll mark it cleared\n\n" +
        "🎯 *Save for something:*\n" +
        "  · _\"save 200 for friend's trip by friday\"_\n" +
        "  · _\"set aside 100/month for emergency fund\"_\n\n" +
        "❓ *Ask \"can I?\":*\n" +
        "  · _\"can I afford 200?\"_\n" +
        "  · _\"if I spend 60 on dinner?\"_\n\n" +
        "🔢 *What the numbers mean:*\n" +
        "  · *To spend today* — what's left RIGHT NOW. Drops as you spend.\n" +
        "  · *Daily pace* — your steady allowance per day.\n" +
        "  · *Available* — balance minus reservations for bills.\n" +
        "  · *In account* — what's literally in your bank.\n\n" +
        "⚡ *Commands:*\n" +
        "  /today — current status\n" +
        "  /bills — bills (tap to pay)\n" +
        "  /undo — undo last action\n" +
        "  /app — open dashboard\n" +
        "  /language — switch UI language (en / ru)\n" +
        "  /currency — change currency (USD / RUB / EUR / KZT…)\n" +
        "  /privacy — how your data is handled\n" +
        "  /export — download everything (JSON)\n" +
        "  /reset — wipe everything\n\n" +
        "_\"The math is done. You just spend.\"_";
    await safeReply(ctx, helpText, { parse_mode: "Markdown" });
    return;
  }
  if (command === "today") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    if (!state.setup) {
      await safeReply(ctx, lang === "ru" ? "Сначала настроим — какой баланс?" : "Set up first — what's your balance?");
      return;
    }
    // /today now shows hero + upcoming bills (next 14 days). Bills
    // were getting forgotten — surfacing them on the daily check makes
    // them present in the daily ritual without adding new concepts.
    const lines = [heroLineWithInsight(state, lang)];
    const sym = state.currencySymbol || "$";
    const today = m.today(state.timezone || "UTC");
    const upcomingBills = Object.values(state.bills || {})
      .filter(b => !b.paidThisCycle)
      .map(b => ({ ...b, daysUntil: m.daysBetween(today, b.dueDate) }))
      .filter(b => b.daysUntil <= 14)
      .sort((a, b) => a.daysUntil - b.daysUntil);
    if (upcomingBills.length > 0) {
      lines.push("");
      lines.push(lang === "ru" ? "*Что впереди:*" : "*What's coming up:*");
      for (const b of upcomingBills) {
        const dueLine = b.daysUntil < 0
          ? (lang === "ru" ? "просрочено " + Math.abs(b.daysUntil) + " дн" : "overdue " + Math.abs(b.daysUntil) + "d")
          : b.daysUntil === 0
            ? (lang === "ru" ? "сегодня" : "today")
            : b.daysUntil === 1
              ? (lang === "ru" ? "завтра" : "tomorrow")
              : (lang === "ru" ? "через " + b.daysUntil + " дн" : "in " + b.daysUntil + "d");
        lines.push("  • " + m.escapeMd(b.name) + " — " + m.toMoney(b.amountCents, sym) + " · " + dueLine);
      }
      lines.push("");
      lines.push(lang === "ru" ? "_Когда оплатил, напиши «оплатил аренду» или «paid X»._" : "_When you pay one, just say \"paid rent\" or \"paid the phone bill\" — I'll mark it done._");
    }
    await safeReply(ctx, lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }
  // ── /bills — the commitment lifecycle made tappable ──────────
  // Lists outstanding (unpaid this cycle) bills + recurring bills with
  // inline [✓ Pay] buttons. One tap applies bill_payment instantly
  // (reversible via /undo). The view is regenerated fresh each
  // invocation so buttons never go stale — solves the chat-buttons-
  // expire problem by being a query, not a persistent card.
  //
  // Layout:
  //   *Unpaid this cycle:*
  //     · Friend — €200 ≈ $216 · due Friday   [✓ Pay Friend]
  //     · Dry cleaning — $40 · due Saturday   [✓ Pay Dry cleaning]
  //
  //   *Recurring:*
  //     · Rent — $1,400 · next 1st            [✓ Pay this cycle]
  //
  //   *Paid this cycle:*  (collapsed in text, just listed)
  //     · Internet — $60 · paid May 5
  //
  // After tap, the bot edits the keyboard to remove that bill's button
  // and sends a confirmation. User can /undo if it was a mistake.
  if (command === "bills") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    if (!state.setup) {
      await safeReply(ctx, lang === "ru" ? "Сначала настроим — какой баланс?" : "Set up first — what's your balance?");
      return;
    }
    const sym = state.currencySymbol || "$";
    const today = m.today(state.timezone || "UTC");
    const ccy = require("./currency");

    // Helpers
    const formatAmount = (b) => {
      if (b.originalCurrency && Number.isFinite(b.originalAmount) && b.originalAmount > 0) {
        const fromSubunits = ccy.spokenToSubunits(b.originalAmount, b.originalCurrency);
        return ccy.fmt(fromSubunits, b.originalCurrency) + " ≈ " + m.toMoney(b.amountCents, sym);
      }
      return m.toMoney(b.amountCents, sym);
    };
    const formatDue = (dueDate) => {
      const days = m.daysBetween(today, dueDate);
      if (days < 0) return lang === "ru" ? "просрочено " + Math.abs(days) + " дн" : "overdue " + Math.abs(days) + "d";
      if (days === 0) return lang === "ru" ? "сегодня" : "today";
      if (days === 1) return lang === "ru" ? "завтра" : "tomorrow";
      if (days <= 14) return lang === "ru" ? "через " + days + " дн" : "in " + days + "d";
      try {
        const dt = new Date(dueDate + "T12:00:00Z");
        return dt.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US", { month: "short", day: "numeric" });
      } catch { return dueDate; }
    };

    const allBills = Object.entries(state.bills || {})
      .map(([key, b]) => Object.assign({ billKey: key }, b))
      .filter(b => b && b.name);

    if (allBills.length === 0) {
      const msg = lang === "ru"
        ? "_Пока нет счетов. Напиши, например, «аренда 1400 первого числа», чтобы добавить._"
        : "_No bills yet. Type something like \"rent 1400 due the 1st\" to add one._";
      await safeReply(ctx, msg, { parse_mode: "Markdown" });
      return;
    }

    // Buckets
    const recurringKinds = new Set(["monthly", "weekly", "biweekly"]);
    const unpaidOnce = allBills.filter(b => !b.paidThisCycle && (!b.recurrence || b.recurrence === "once"));
    const recurring = allBills.filter(b => recurringKinds.has(b.recurrence));
    const paidThisCycle = allBills.filter(b => b.paidThisCycle);

    const lines = [];
    const buttons = []; // each entry is a row (array of button objects)

    if (unpaidOnce.length > 0) {
      lines.push(lang === "ru" ? "*Не оплачено в этом цикле:*" : "*Unpaid this cycle:*");
      // Sort by dueDate ascending (most urgent first)
      unpaidOnce.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
      for (const b of unpaidOnce) {
        lines.push("  · " + m.escapeMd(b.name) + " — " + formatAmount(b) + " · " + formatDue(b.dueDate));
        const label = (lang === "ru" ? "✓ Оплатить " : "✓ Pay ") + (b.name.length > 30 ? b.name.slice(0, 27) + "…" : b.name);
        buttons.push([{ text: label, callback_data: "paybill:" + b.billKey }]);
      }
    }

    if (recurring.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(lang === "ru" ? "*Регулярные:*" : "*Recurring:*");
      // Unpaid-this-cycle recurring bills first
      recurring.sort((a, b) => (a.paidThisCycle ? 1 : 0) - (b.paidThisCycle ? 1 : 0)
                              || String(a.dueDate).localeCompare(String(b.dueDate)));
      for (const b of recurring) {
        const status = b.paidThisCycle
          ? (lang === "ru" ? " · ✓ оплачено" : " · ✓ paid")
          : "";
        lines.push("  · " + m.escapeMd(b.name) + " — " + formatAmount(b) + " · " +
                   (lang === "ru" ? "след. " : "next ") + formatDue(b.dueDate) +
                   " · " + b.recurrence + status);
        // Inline Pay button only for unpaid recurring (paid this cycle =
        // already done, will auto-cycle next).
        if (!b.paidThisCycle) {
          const label = (lang === "ru" ? "✓ Оплатить " : "✓ Pay ") + (b.name.length > 30 ? b.name.slice(0, 27) + "…" : b.name);
          buttons.push([{ text: label, callback_data: "paybill:" + b.billKey }]);
        }
      }
    }

    if (paidThisCycle.filter(b => !b.recurrence || b.recurrence === "once").length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(lang === "ru" ? "*Оплачено в этом цикле:*" : "*Paid this cycle:*");
      const paidOnces = paidThisCycle.filter(b => !b.recurrence || b.recurrence === "once");
      paidOnces.sort((a, b) => String(b.dueDate).localeCompare(String(a.dueDate)));
      for (const b of paidOnces) {
        lines.push("  · " + m.escapeMd(b.name) + " — " + formatAmount(b) + " · ✓");
      }
    }

    // Footer link to mini app
    const url = process.env.MINIAPP_URL;
    if (url) {
      buttons.push([{ text: lang === "ru" ? "Открыть в приложении" : "Open in app", web_app: { url } }]);
    }

    const text = lines.join("\n");
    await safeReply(ctx, text, {
      parse_mode: "Markdown",
      reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
    });
    return;
  }

  if (command === "undo") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    await db.withUserLock(u.id, async () => {
      let state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";
      if (!state.setup) {
        await safeReply(ctx, lang === "ru" ? "Ещё нечего отменять." : "Nothing to undo yet.");
        return;
      }
      try {
        const r = applyIntent(state, { kind: "undo_last", params: {} });
        await db.saveState(prisma, u.id, r.state);
        const what = r.event.undid && r.event.undid.intent
          ? describeIntent(r.event.undid.intent, state)
          : "";
        const head = lang === "ru" ? "Отменено" : "Undone";
        await safeReply(ctx, head + (what ? ": " + what : "") + "\n" + heroLine(r.state, lang), { parse_mode: "Markdown" });
      } catch (e) {
        await safeReply(ctx, "_" + m.escapeMd(translateErr(e, lang)) + "_", { parse_mode: "Markdown" });
      }
    });
    return;
  }
  if (command === "reset") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    const token = setPending(state, { kind: "reset", params: {} });
    await db.saveState(prisma, u.id, state);
    const text = lang === "ru"
      ? "*Это удалит все данные.* Точно?"
      : "*This will wipe everything.* Are you sure?";
    const yesLabel = lang === "ru" ? "Да, сбросить" : "Yes, reset";
    const noLabel = lang === "ru" ? "Отмена" : "Cancel";
    await safeReply(ctx, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: yesLabel, callback_data: "yes:" + token },
          { text: noLabel, callback_data: "no:" + token },
        ]],
      },
    });
    return;
  }
  if (command === "app") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    const url = process.env.MINIAPP_URL;
    if (!url) { await safeReply(ctx, M(lang, "miniAppNotConfigured")); return; }
    await safeReply(ctx, M(lang, "miniAppOpen"), {
      reply_markup: { inline_keyboard: [[{ text: lang === "ru" ? "Открыть" : "Open", web_app: { url } }]] },
    });
    return;
  }
  // ── /language — switch UI language (anytime) ──────────────
  // The first-turn auto-detection takes a best guess from the user's
  // Telegram locale. If wrong (or if it changed), /language lets them
  // fix it without losing data. Two args: bare /language shows current
  // + options; /language en or /language ru switches.
  if (command === "language") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const arg = String(payload || "").trim().toLowerCase().split(/\s+/)[0];
    const wanted = arg ? normalizeLang(arg) : null;
    if (!arg) {
      // Show current + options
      const curr = state.language || "en";
      const ru = curr === "ru";
      await safeReply(ctx,
        (ru ? "Сейчас: *русский* 🇷🇺" : "Current: *English* 🇬🇧") + "\n\n" +
        (ru ? "Переключить: `/language en`" : "Switch: `/language ru`"),
        { parse_mode: "Markdown" });
      return;
    }
    state.language = wanted;
    await db.saveState(prisma, u.id, state);
    await safeReply(ctx, wanted === "ru"
      ? "Готово ✅ Теперь общаюсь по-русски."
      : "Done ✅ Switched to English.", { parse_mode: "Markdown" });
    return;
  }

  // ── /currency — switch base currency (anytime) ─────────────
  // Changes the formatting symbol/code for ALL display going forward.
  // CRITICAL: doesn't retroactively convert stored cents — past
  // numbers continue to display in the new symbol but the underlying
  // value is the same integer. User must manually adjust_balance if
  // they're truly converting (e.g. moved countries with money in tow).
  // Bare /currency shows current + common options.
  if (command === "currency") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    const arg = String(payload || "").trim().toUpperCase().split(/\s+/)[0];
    if (!arg) {
      const curr = state.currency || "USD";
      const sym = state.currencySymbol || "$";
      await safeReply(ctx, lang === "ru"
        ? "Сейчас: *" + sym + " " + curr + "*\n\nПопулярные: `/currency RUB` `/currency USD` `/currency EUR` `/currency KZT` `/currency GBP` `/currency BYN` `/currency UAH`"
        : "Current: *" + sym + " " + curr + "*\n\nCommon: `/currency RUB` `/currency USD` `/currency EUR` `/currency KZT` `/currency GBP` `/currency BYN` `/currency UAH`",
        { parse_mode: "Markdown" });
      return;
    }
    // Look up the symbol for the requested currency code. Use the
    // existing currency module which has the full ISO table.
    const currency = require("./currency");
    let sym;
    try { sym = currency.symbolFor(arg); } catch { sym = null; }
    if (!sym) {
      await safeReply(ctx, lang === "ru"
        ? "_Не знаю валюту «" + arg + "». Используй ISO-код (USD, EUR, RUB, KZT...)._"
        : "_Don't know currency \"" + arg + "\". Use an ISO code (USD, EUR, RUB, KZT...)._",
        { parse_mode: "Markdown" });
      return;
    }
    state.currency = arg;
    state.currencySymbol = sym;
    await db.saveState(prisma, u.id, state);
    await safeReply(ctx, lang === "ru"
      ? "Готово ✅ Валюта: *" + sym + " " + arg + "*.\n\n_Я не пересчитываю прошлые суммы — если ты сменил(а) страну с деньгами, скорректируй баланс через «у меня сейчас X»._"
      : "Done ✅ Currency: *" + sym + " " + arg + "*.\n\n_I don't re-convert past amounts — if you actually moved countries with money, adjust your balance via \"I now have X\"._",
      { parse_mode: "Markdown" });
    return;
  }

  // ── /privacy — plain-language data policy ──────────────────
  // What we collect, where it goes, and the user's rights. Money apps
  // earn trust by being clear about this BEFORE the user asks. Spendkitty
  // is built around restraint — and that should be visible.
  if (command === "privacy") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    const text = lang === "ru"
      ? "*Прозрачность и приватность*\n\n" +
        "*Что я храню:*\n" +
        "• Твой Telegram ID (чтобы тебя узнавать)\n" +
        "• То, что ты мне пишешь (траты, счета, баланс)\n" +
        "• Производные расчёты (твой дневной темп, лимиты)\n\n" +
        "*Куда это уходит:*\n" +
        "• Хранится на моих серверах (Railway, шифрование на диске)\n" +
        "• Текстовые сообщения обрабатываются через OpenAI для понимания (они не обучают модели на API-данных)\n" +
        "• Никаких трекеров, рекламы, продажи данных. Не подключаюсь к банкам.\n\n" +
        "*Твои права:*\n" +
        "• /export — выгрузить все свои данные (JSON)\n" +
        "• /reset — стереть всё. Полностью. Без вопросов.\n\n" +
        "_Кошельки большие — мы маленькие. Чем меньше я знаю, тем лучше работаю._"
      : "*How your data is handled*\n\n" +
        "*What I store:*\n" +
        "• Your Telegram ID (to recognize you)\n" +
        "• What you tell me (spends, bills, balance)\n" +
        "• Derived numbers (your daily pace, limits)\n\n" +
        "*Where it goes:*\n" +
        "• Stays on my servers (Railway, encrypted at rest)\n" +
        "• Text messages are processed via OpenAI for understanding (they don't train on API data)\n" +
        "• No trackers, no ads, no data sale. No bank link.\n\n" +
        "*Your rights:*\n" +
        "• /export — download all your data (JSON)\n" +
        "• /reset — wipe everything. No questions asked.\n\n" +
        "_The less I know about you, the better I work._";
    await safeReply(ctx, text, { parse_mode: "Markdown" });
    return;
  }

  // ── /export — GDPR-style "give me my data" ─────────────────
  // Emit the user's full state as JSON. For small accounts (<3KB) we
  // inline it in chat. Larger payloads go as a .json file attachment
  // so Telegram doesn't truncate.
  if (command === "export") {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    // Build the export payload — everything the user has typed plus
    // derived state. Exclude internal session fields the user never sees.
    const payload = {
      _meta: {
        exportedAt: new Date().toISOString(),
        format: "spendkitty-export-v1",
        telegramId: String(telegramId),
      },
      setup: state.setup || false,
      language: state.language || "en",
      currency: state.currency,
      currencySymbol: state.currencySymbol,
      timezone: state.timezone,
      balanceCents: state.balanceCents,
      payday: state.payday,
      payFrequency: state.payFrequency,
      bills: state.bills || {},
      transactions: state.transactions || [],
      events: state.events || [],
      paceHistory: state.paceHistory || {},
    };
    const json = JSON.stringify(payload, null, 2);
    // Telegram caps text messages at ~4096 chars. JSON code blocks
    // overhead → use 3500 for the inline threshold.
    if (json.length <= 3500) {
      const head = lang === "ru" ? "*Твои данные:*" : "*Your data:*";
      await safeReply(ctx, head + "\n```json\n" + json + "\n```", { parse_mode: "Markdown" });
    } else {
      // Larger payloads — send as a file. Telegram supports document
      // upload via InputFile (Buffer + filename).
      try {
        const buf = Buffer.from(json, "utf8");
        const fname = "spendkitty-export-" + (state.language || "en") + "-" + new Date().toISOString().slice(0, 10) + ".json";
        await ctx.replyWithDocument({ source: buf, filename: fname }, {
          caption: lang === "ru" ? "Твои данные на Spendkitty" : "Your Spendkitty data",
        });
      } catch (e) {
        console.error("[v5 /export]", e);
        await safeReply(ctx, lang === "ru" ? "_Не удалось выгрузить — попробуй позже._" : "_Couldn't export — try again later._", { parse_mode: "Markdown" });
      }
    }
    return;
  }

  if (command === "debug") {
    // Production dev tool — show the last few raw AI responses for this
    // user. Lets you (the dev / Claude) inspect what the AI saw without
    // asking the user to retest. Truncates each entry for chat readability.
    const arr = getAiRaw(telegramId);
    if (arr.length === 0) {
      await safeReply(ctx, "_No AI calls captured yet for this session._", { parse_mode: "Markdown" });
      return;
    }
    const lines = arr.map((e, i) => {
      const ago = Math.max(0, Math.round((Date.now() - e.ts) / 1000)) + "s ago";
      const r = e.raw && e.raw.length > 1500 ? e.raw.slice(0, 1500) + "…" : (e.raw || "");
      return "*[ai " + (i + 1) + " · " + ago + "]*\n```\n" + r.replace(/`/g, "'") + "\n```";
    });
    // Warnings attached to the most recent turn (from pipeline tripwires
    // — e.g. "user said yesterday but AI dropped the date"). Surfaces
    // silent compliance failures so we catch them without retesting.
    const warnings = getWarnings(telegramId);
    let output = lines.join("\n\n");
    if (warnings.length > 0) {
      output += "\n\n*[tripwires on latest turn]*\n" +
        warnings.map(w => "  " + w.message).join("\n");
    }
    await safeReply(ctx, output, { parse_mode: "Markdown" });
    return;
  }
}

// processCallbackData handles inline-button taps (yes/no/undo).
async function processCallbackData(prisma, ctx, telegramId, data) {
  // Undo button (after a confirm-applied action).
  if (data.startsWith("undo:")) {
    const eventId = data.slice(5);
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    await db.withUserLock(u.id, async () => {
      let state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";
      const last = state.events && state.events.length ? state.events[state.events.length - 1] : null;
      if (!last || last.id !== eventId) {
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await safeReply(ctx, lang === "ru" ? "Уже произошли другие действия — кнопка устарела." : "Other actions happened since — undo expired.");
        return;
      }
      try {
        const r = applyIntent(state, { kind: "undo_last", params: {} });
        await db.saveState(prisma, u.id, r.state);
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await safeReply(ctx, (lang === "ru" ? "Отменено.\n" : "Undone.\n") + heroLine(r.state, lang), { parse_mode: "Markdown" });
      } catch (e) {
        await safeReply(ctx, "_" + m.escapeMd(translateErr(e, lang)) + "_", { parse_mode: "Markdown" });
      }
    });
    return;
  }

  // ── /bills Pay button ──────────────────────────────────────
  // Tapped from the /bills inline keyboard. One-tap bill_payment.
  // Reversible via /undo (just like every other applied action).
  //
  // Defensive: if the bill is already paid (e.g. user re-tapped after
  // sync from mini app), show a polite "already paid" notice. If the
  // bill no longer exists (deleted), show that too. Never crash.
  //
  // After success: edit the original /bills message's inline keyboard
  // to remove THIS bill's button (so re-tapping is impossible) and
  // send a confirmation message with hero update.
  if (data.startsWith("paybill:")) {
    const billKey = data.slice(8);
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    await db.withUserLock(u.id, async () => {
      let state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";
      const bill = state.bills && state.bills[billKey];
      if (!bill) {
        await safeReply(ctx, "_" + (lang === "ru" ? "Счёт не найден." : "Bill not found.") + "_", { parse_mode: "Markdown" });
        return;
      }
      if (bill.paidThisCycle) {
        await safeReply(ctx, "_" + (lang === "ru" ? "Уже оплачено в этом цикле." : "Already paid this cycle.") + "_", { parse_mode: "Markdown" });
        return;
      }
      const intent = {
        kind: "record_spend",
        params: {
          amountCents: bill.amountCents,
          billKey,
          note: bill.name,
        },
      };
      // Preserve foreign-currency info so history shows "€200 ≈ $216".
      if (bill.originalCurrency && Number.isFinite(bill.originalAmount) && bill.originalAmount > 0) {
        intent.params.originalAmount = bill.originalAmount;
        intent.params.originalCurrency = bill.originalCurrency;
      }
      const todayStr = m.today(state.timezone || "UTC");
      const v = require("./validator").validateIntent(state, intent, todayStr, lang);
      if (!v.ok) {
        const reasonText = v.clarify ? v.clarify.question : v.reason;
        await safeReply(ctx, "_" + m.escapeMd(reasonText || "") + "_", { parse_mode: "Markdown" });
        return;
      }
      try {
        const r = applyIntent(state, intent);
        await db.saveState(prisma, u.id, r.state);

        // Edit the /bills keyboard: remove the row whose button matched
        // this billKey so the user can't re-tap. Other rows preserved.
        try {
          const kb = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup;
          if (kb && Array.isArray(kb.inline_keyboard)) {
            const newRows = kb.inline_keyboard.filter(row =>
              !row.some(btn => btn && btn.callback_data === "paybill:" + billKey)
            );
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: newRows } }).catch(() => {});
          }
        } catch { /* best effort */ }

        // Send confirmation + hero. Mention pace UNCHANGED — because
        // bill_payment doesn't refresh pace (Model B + symmetry rule).
        // That's the user-visible AAA: pace stays put because the
        // reservation already carved it out.
        const sym = state.currencySymbol || "$";
        const isForeign = bill.originalCurrency && Number.isFinite(bill.originalAmount) && bill.originalAmount > 0;
        let amountPhrase;
        if (isForeign) {
          const ccy = require("./currency");
          const fromSubunits = ccy.spokenToSubunits(bill.originalAmount, bill.originalCurrency);
          amountPhrase = ccy.fmt(fromSubunits, bill.originalCurrency) + " ≈ " + m.toMoney(bill.amountCents, sym);
        } else {
          amountPhrase = m.toMoney(bill.amountCents, sym);
        }
        const head = lang === "ru"
          ? "✓ Оплачено *" + m.escapeMd(bill.name) + "* — " + amountPhrase
          : "✓ Paid *" + m.escapeMd(bill.name) + "* — " + amountPhrase;
        await safeReply(ctx, head + "\n" + heroLine(r.state, lang), { parse_mode: "Markdown" });
      } catch (e) {
        console.error("[v5 paybill]", e);
        await safeReply(ctx, "_" + m.escapeMd(translateErr(e, lang)) + "_", { parse_mode: "Markdown" });
      }
    });
    return;
  }

  if (!data.startsWith("yes:") && !data.startsWith("no:")) return;
  const isYes = data.startsWith("yes:");
  // Bug pre-fix: "yes:" is 4 chars but "no:" is 3 — slicing 4 dropped a
  // char of the token, takePending always returned null, every Cancel tap
  // hit the "expired" path. Use the exact prefix length.
  const token = data.slice(isYes ? 4 : 3);
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  let state = await db.loadState(prisma, u.id);
  // takePending now reads from state.pendingTokens (persisted across deploys).
  // Removes the entry from state — caller saves below.
  const entry = takePending(state, token);
  const lang = state.language === "ru" ? "ru" : "en";

  // Critical: every safeEdit on a confirm card MUST clear the inline
  // keyboard. Otherwise stale buttons remain tappable, the user re-taps,
  // hits the expired path, and the bot looks broken. Telegram's API
  // requires reply_markup to be passed explicitly to clear.
  const clearButtons = { reply_markup: { inline_keyboard: [] } };

  if (!entry) {
    await safeEdit(ctx, lang === "ru" ? "Кнопка устарела." : "That confirm has expired.", clearButtons);
    return;
  }
  // Save state (entry was removed). UserId check no longer needed —
  // tokens live on the user's own state, can only be popped by them.
  await db.saveState(prisma, u.id, state);
  if (!isYes) {
    // Brief, friendly skip. Don't echo the intent details ("Cancelled —
    // Spend $200 · jacket") because for decision/afford flow the user
    // didn't actually want to spend; that wording is misleading.
    // Single line, clears buttons.
    const cancelText = lang === "ru" ? "Понял — пропускаю." : "Got it — skipped.";
    await safeEdit(ctx, cancelText, Object.assign({ parse_mode: "Markdown" }, clearButtons));
    return;
  }

  await db.withUserLock(u.id, async () => {
    state = await db.loadState(prisma, u.id);
    const intents = entry.intents || (entry.intent ? [entry.intent] : []);
    const applied = [];
    const failed = [];
    try {
      for (const intent of intents) {
        // Re-validate against the CURRENT state — applying intent N may
        // have changed conditions for intent N+1 (e.g. balance check).
        const todayStr = m.today(state.timezone || "UTC");
        const v = require("./validator").validateIntent(state, intent, todayStr, lang);
        if (!v.ok) { failed.push({ intent, reason: v.reason }); continue; }
        try {
          const r = applyIntent(state, intent);
          state = r.state;
          applied.push(intent);
        } catch (e) {
          failed.push({ intent, reason: translateErr(e, lang) });
        }
      }
      if (applied.length > 0) await db.saveState(prisma, u.id, state);

      // No inline undo button. Goal-Layer iteration: even on the
      // confirm card, the button gets tapped accidentally by anxious
      // users (Carol persona, turns 13/37/63/71). Goals #1 (dismiss
      // hero) and #4 (explore button) drive the accidents — the
      // BUTTON'S EXISTENCE is the problem. Removing it kills both.
      // Goal #3 (real mistake) is preserved via the typed /undo
      // command, which requires intent (no fat-finger).
      //
      // Confirm card: ✓ summary, NO buttons. Hero: pure info, NO
      // buttons. /undo command: explicit recovery for the rare real
      // mistake case.
      // Build summary lines. For undo_last specifically: instead of the
      // generic "Undo last action" describeIntent, dig into the event
      // log to show WHAT was actually undone — "Undid: Spend $50 · cat".
      // (User reported: "Actually I didn't get the cat" → bot said
      // "Undo last action" but had silently undone the JUICE, not the
      // cat. The user couldn't tell.)
      const summaryLines = applied.map(i => {
        if (i.kind === "undo_last") {
          const lastEvent = state.events && state.events.length ? state.events[state.events.length - 1] : null;
          if (lastEvent && lastEvent.intent && lastEvent.intent.kind === "undo_last" && lastEvent.undid && lastEvent.undid.intent) {
            const undoneDesc = describeIntent(lastEvent.undid.intent, state);
            return "✓ " + (lang === "ru" ? "Отменено: " : "Undid: ") + undoneDesc;
          }
        }
        if (i.kind === "delete_transaction") {
          // describeIntent looks up the tx by id and renders its details.
          // Same lookup works post-apply because the tx is still in the
          // array (just marked deletedAt).
          return "✓ " + (lang === "ru" ? "Удалено: " : "Deleted: ") + describeIntent(i, state).replace(/^Delete: |^Удалить: /, "");
        }
        return "✓ " + describeIntent(i, state);
      });
      const failedLines = failed.map(f => (lang === "ru" ? "✗ " : "✗ ") + describeIntent(f.intent, state) + " — _" + m.escapeMd(f.reason) + "_");
      let summary = summaryLines.concat(failedLines).join("\n");

      // Add a soft hint about /undo on the FIRST confirmed action of a
      // session — educates without nagging. We only add it when the
      // confirm card is showing a single applied action so the message
      // stays tight.
      if (applied.length === 1 && applied[0].kind !== "undo_last" && applied[0].kind !== "reset") {
        const hint = lang === "ru"
          ? "\n_(если это ошибка — напиши /undo)_"
          : "\n_(if this was a mistake, type /undo)_";
        summary += hint;
      }

      const isResetOnly = applied.length === 1 && applied[0].kind === "reset";
      await safeEdit(ctx, summary || (lang === "ru" ? "Ничего не применили." : "Nothing applied."),
        Object.assign({ parse_mode: "Markdown" }, clearButtons));

      if (isResetOnly) {
        // Welcome message after reset — properly re-introduces the bot
        // rather than jumping straight to a balance question, which felt
        // disorienting (user reported feeling lost mid-flow). Two-line
        // intro then the same balance ask as fresh onboarding.
        const welcome = lang === "ru"
          ? "Сброшено ✅\n\nПривет, я *Spendkitty* — твой денежный приятель. Я помогу следить за тратами, счетами и тем, сколько у тебя свободного времени до зарплаты.\n\nДавай начнём с начала: сколько примерно сейчас на счёте?"
          : "Reset ✅\n\nHi, I'm *Spendkitty* — your money buddy. I'll help you keep tabs on spending, bills, and how much daily wiggle-room you have until payday.\n\nLet's start from scratch: what's roughly in your account?";
        await safeReply(ctx, welcome, { parse_mode: "Markdown" });
        return;
      }
      if (applied.length === 0) return;

      // ── LIFECYCLE HINT ───────────────────────────────────
      // When the user reserves money via add_bill (without immediately
      // paying it in the SAME batch), the bot's response should hint
      // at the next phase: how to mark it paid when the money actually
      // leaves. Without this hint the user wonders "now what?" — does
      // it auto-pay? do I track it? AAA UX = close the loop.
      //
      // Skip the hint for commitment_choice flow (add_bill+pay in same
      // batch — already done) and for non-bill intents.
      const reservations = applied.filter((i, idx) => {
        if (i.kind !== "add_bill") return false;
        const billKey = m.billKey((i.params && i.params.name) || "");
        if (!billKey) return false;
        // Paired payment in same batch → not a reservation, suppress.
        const paidInBatch = applied.some((j, jdx) =>
          jdx !== idx && j.kind === "record_spend" && j.params && j.params.billKey === billKey
        );
        return !paidInBatch;
      });
      let lifecycleHint = "";
      if (reservations.length > 0) {
        // One name → inline; multiple → comma list.
        const names = reservations.map(i => i.params.name).join(", ");
        lifecycleHint = lang === "ru"
          ? "\n\n_Когда заплатишь — напиши «оплатил " + m.escapeMd(names) + "» или открой приложение, чтобы отметить._"
          : "\n\n_When you pay, just say \"paid " + m.escapeMd(names) + "\" or tap it in the app to mark it._";
      }

      // Hero post-confirm: facts only. The auto-pushed insight after
      // every spend was noise — moved to pull-only (/today + AI question
      // replies) per user feedback. AAA brand register: quiet by default.
      await safeReply(ctx, heroLine(state, lang) + lifecycleHint, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[v5 confirm apply]", e);
      await safeEdit(ctx, "_" + m.escapeMd(translateErr(e, lang)) + "_", Object.assign({ parse_mode: "Markdown" }, clearButtons));
    }
  });
}

// ── HANDLERS (grammy adapter) ────────────────────
function attach(prisma) {
  if (!bot) return;

  bot.command("start", (ctx) => processCommand(prisma, ctx, ctx.from.id, "start").catch(e => console.error("[v5 /start]", e)));
  bot.command("today", (ctx) => processCommand(prisma, ctx, ctx.from.id, "today").catch(e => console.error("[v5 /today]", e)));
  bot.command("bills", (ctx) => processCommand(prisma, ctx, ctx.from.id, "bills").catch(e => console.error("[v5 /bills]", e)));
  bot.command("undo",  (ctx) => processCommand(prisma, ctx, ctx.from.id, "undo").catch(e => console.error("[v5 /undo]", e)));
  bot.command("reset", (ctx) => processCommand(prisma, ctx, ctx.from.id, "reset").catch(e => console.error("[v5 /reset]", e)));
  bot.command("app",   (ctx) => processCommand(prisma, ctx, ctx.from.id, "app").catch(e => console.error("[v5 /app]", e)));
  bot.command("debug", (ctx) => processCommand(prisma, ctx, ctx.from.id, "debug").catch(e => console.error("[v5 /debug]", e)));
  bot.command("language", (ctx) => processCommand(prisma, ctx, ctx.from.id, "language", ctx.match || "").catch(e => console.error("[v5 /language]", e)));
  bot.command("currency", (ctx) => processCommand(prisma, ctx, ctx.from.id, "currency", ctx.match || "").catch(e => console.error("[v5 /currency]", e)));
  bot.command("privacy", (ctx) => processCommand(prisma, ctx, ctx.from.id, "privacy").catch(e => console.error("[v5 /privacy]", e)));
  bot.command("export", (ctx) => processCommand(prisma, ctx, ctx.from.id, "export").catch(e => console.error("[v5 /export]", e)));
  bot.command("help",  (ctx) => processCommand(prisma, ctx, ctx.from.id, "help").catch(e => console.error("[v5 /help]", e)));

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || (text.startsWith("/") && text.length < 30)) return;
    try {
      await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v5 text]", e);
    }
  });

  // Photo / receipt handler — sends to vision-capable LLM, gets a
  // structured record_spend intent, shows confirm card. Same safety
  // pattern as voice / text: AI proposes, user confirms.
  bot.on("message:photo", async (ctx) => {
    let statusMsg = null;
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";

      if (!state.setup) {
        await safeReply(ctx, lang === "ru"
          ? "_Сначала настроим — напиши примерный баланс._"
          : "_Set up first — tell me your rough balance._",
          { parse_mode: "Markdown" });
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        await safeReply(ctx, lang === "ru"
          ? "_Не могу прочитать чек — нужен OpenAI ключ._"
          : "_Can't read receipts — vision API not configured._",
          { parse_mode: "Markdown" });
        return;
      }

      // Show "scanning…" so the user knows it's working (vision call
      // takes a few seconds).
      try {
        statusMsg = await ctx.reply(lang === "ru" ? "📸 _Читаю чек…_" : "📸 _Reading receipt…_", { parse_mode: "Markdown" });
      } catch {}
      try { ctx.replyWithChatAction("typing"); } catch {}

      // Pick the best photo size (highest resolution Telegram offers).
      const photos = ctx.message && ctx.message.photo;
      if (!photos || !photos.length) return;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const url = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(url, { signal: ctrl.signal });
      const buf = Buffer.from(await resp.arrayBuffer());
      clearTimeout(tt);

      const vision = require("./ai-vision");
      const r = await vision.extractFromReceipt(buf, Object.assign({}, state, { id: ctx.from.id }));

      // Clear the "scanning…" message.
      if (statusMsg) {
        try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
        statusMsg = null;
      }

      if (!r.ok) {
        await safeReply(ctx, "_" + m.escapeMd(r.reason || "Couldn't read that.") + "_",
          { parse_mode: "Markdown" });
        return;
      }

      // Run the same conversion as the text path — pipeline normalizes
      // foreign currency. Reuse processMessage's path? Simpler: feed
      // the intent through validate + setPending directly.
      const todayStr = m.today(state.timezone || "UTC");

      // Currency conversion (same logic as pipeline.convertOnce).
      const currency = require("./currency");
      const p = r.intent.params || {};
      if (p.originalCurrency && Number.isFinite(p.originalAmount) && p.originalAmount > 0) {
        const base = state.currency || "USD";
        const fromSubunits = currency.spokenToSubunits(p.originalAmount, p.originalCurrency);
        // Pass tx.date for historical-rate accuracy on backdated spends.
        const toSubunits = currency.convertSubunits(fromSubunits, p.originalCurrency, base, p.date || null);
        p.amountCents = toSubunits;
      }

      const v = require("./validator").validateIntent(state, r.intent, todayStr, lang);
      if (!v.ok) {
        // Photo path: a clarify here would mean the receipt OCR missed
        // a required field (rare — receipts have amount + date + vendor).
        // Render the question / reason as plain text either way.
        const txt = v.clarify ? v.clarify.question : v.reason;
        await safeReply(ctx, "_" + m.escapeMd(txt || "") + "_", { parse_mode: "Markdown" });
        return;
      }

      // setPending now writes to state.pendingTokens (persisted) so the
      // confirm card survives Railway redeploys. Save state immediately.
      const token = setPending(state, r.intent);
      await db.saveState(prisma, u.id, state);
      const card = describeIntent(r.intent, state);
      const fromPhoto = lang === "ru" ? "📸 *Из чека:*" : "📸 *From receipt:*";
      await safeReply(ctx, fromPhoto + "\n" + card, {
        parse_mode: "Markdown",
        ...confirmKeyboard(token, lang, r.intent),
      });
    } catch (e) {
      console.error("[v5 photo]", e);
      if (statusMsg) {
        try { await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {}
      }
      try {
        const lang2 = (await db.loadState(prisma, (await db.resolveUser(prisma, "tg_" + ctx.from.id)).id)).language === "ru" ? "ru" : "en";
        await safeReply(ctx, "_" + (lang2 === "ru" ? "Не удалось обработать фото." : "Couldn't process the photo.") + "_", { parse_mode: "Markdown" });
      } catch {}
    }
  });

  // Documents (PDF, doc) — bank statements maybe one day. For now,
  // honest no.
  bot.on("message:document", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";
      await safeReply(ctx, lang === "ru"
        ? "_Документы пока не читаю — отправь фото чека или напиши._"
        : "_I can't read docs yet — send a photo of the receipt or just type it._",
        { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[v5 document]", e);
    }
  });

  bot.on("message:voice", async (ctx) => {
    if (!process.env.OPENAI_API_KEY) {
      await safeReply(ctx, "Voice not enabled — please type instead.");
      return;
    }
    try {
      const file = await ctx.getFile();
      const url = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, { signal: ctrl.signal });
      const buf = Buffer.from(await resp.arrayBuffer());
      clearTimeout(tt);
      const audio = await toFile(buf, "voice.ogg", { type: "audio/ogg" });
      const tr = await openaiClient().audio.transcriptions.create({ file: audio, model: "whisper-1" }, { timeout: 15000 });
      const text = (tr.text || "").slice(0, 2000);
      if (text) await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v5 voice]", e);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await processCallbackData(prisma, ctx, ctx.from.id, data);
    } catch (e) {
      console.error("[v5 callback]", e);
    }
  });
}

module.exports = {
  bot, attach, processText, processCommand, processCallbackData,
  buttonLabelsFor,
  // Exported for tests:
  setPending, setPendingPair, takePending, describeIntent,
};
