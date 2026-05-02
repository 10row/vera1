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
const db = require("./db");

// normalizeLang — accepts Telegram language_code values like "en-US", "ru",
// "ru-RU" and reduces them to the supported set. We support en + ru today;
// everything else falls back to en.
function normalizeLang(code) {
  if (!code) return "en";
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  if (c === "ru") return "ru";
  return "en";
}

// defaultCurrencyForLang — paired with normalizeLang. Russian user gets
// RUB+₽ by default; English gets USD+$. Without this, language commit
// without currency commit shows RU users "$" and breaks trust.
const _DEFAULT_CURRENCY = {
  en: { code: "USD", symbol: "$" },
  ru: { code: "RUB", symbol: "₽" },
};
function defaultCurrencyForLang(lang) {
  return _DEFAULT_CURRENCY[lang] || _DEFAULT_CURRENCY.en;
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
const openai = new OpenAI();

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

// takePending pops the entry from state.pendingTokens (mutates state).
// Returns the entry or null. Caller saves state.
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
  return entry;
}

// ── CONFIRM CARD ──────────────────────────────────
function confirmKeyboard(token, lang) {
  const yes = lang === "ru" ? "Да" : "Yes";
  const no = lang === "ru" ? "Отмена" : "Cancel";
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: yes, callback_data: "yes:" + token },
        { text: no, callback_data: "no:" + token },
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
    case "add_bill":
      return lang === "ru"
        ? "Добавить счёт *" + E(p.name) + "* — " + M(p.amountCents) + " · " + p.dueDate + " · " + p.recurrence
        : "Add bill *" + E(p.name) + "* — " + M(p.amountCents) + " · " + p.dueDate + " · " + p.recurrence;
    case "remove_bill":
      return lang === "ru"
        ? "Удалить счёт *" + E(p.name) + "*"
        : "Remove bill *" + E(p.name) + "*";
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
      return lang === "ru"
        ? "Расход " + amountPhrase + title + catBadge
        : "Spend " + amountPhrase + title + catBadge;
    }
    case "record_income":
      return lang === "ru"
        ? "Доход " + M(p.amountCents) + (p.note ? " · " + E(p.note) : "")
        : "Income " + M(p.amountCents) + (p.note ? " · " + E(p.note) : "");
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
const { recordAiRaw, getAiRaw } = require("./ai-debug");

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

    // Detect language from Telegram's client locale on the first turn (when
    // the user is still virgin: no setup, no transactions). After that the
    // user's language is locked unless they explicitly switch.
    const tgLang = ctx.from && ctx.from.language_code;
    const isVirgin = !state.setup && (!state.transactions || state.transactions.length === 0)
      && (!state.events || state.events.length === 0);
    if (isVirgin && tgLang && state.language !== normalizeLang(tgLang)) {
      state.language = normalizeLang(tgLang);
      // CRITICAL: language change implies currency change for the
      // virgin user. Without this, RU users see "$120,000" and lose
      // trust before turn 3 (persona test 0003.1). Defaults are
      // overridable later via update_settings if user explicitly says
      // "switch to USD".
      const def = defaultCurrencyForLang(state.language);
      state.currency = def.code;
      state.currencySymbol = def.symbol;
      await db.saveState(prisma, u.id, state);
    }

    const lang = state.language === "ru" ? "ru" : "en";
    const history = await db.loadHistory(prisma, u.id);

    // Persist user message into history.
    await db.appendHistory(prisma, u.id, "user", text);

    const result = await processMessage(state, text, history, options);

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
      await safeReply(ctx, reply, { parse_mode: "Markdown" });

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
        const projBalance = M(sim.projected.balanceCents);
        const irregular = state.payFrequency === "irregular";
        if (sim.projected.status === "over") {
          // No: it'd put them over. Be direct.
          lines.push(lang === "ru"
            ? "🔴 *Не стоит* — это даст " + M(sim.projected.deficitCents) + " дефицита. Останется " + projBalance + "."
            : "🔴 *Not really* — that'd put you " + M(sim.projected.deficitCents) + " over. You'd be at " + projBalance + ".");
        } else if (sim.projected.status === "tight") {
          // Maybe: it's tight. Show what's left.
          const horizon = irregular
            ? (lang === "ru" ? " на месяц" : " for a month")
            : (lang === "ru" ? " на " + sim.projected.daysToPayday + " дн" : " for " + sim.projected.daysToPayday + " days");
          lines.push(lang === "ru"
            ? "🟡 *Впритык* — после этого " + projBalance + ", " + sim.projected.dailyPaceFormatted + "/день" + horizon + "."
            : "🟡 *Tight* — after that you'd have " + projBalance + ", " + sim.projected.dailyPaceFormatted + "/day" + horizon + ".");
        } else {
          // Yes: clear. Show after-balance.
          lines.push(lang === "ru"
            ? "🟢 *Да, можно* — после этого " + projBalance + ", " + sim.projected.dailyPaceFormatted + "/день."
            : "🟢 *Yep, you're fine* — after that you'd have " + projBalance + ", " + sim.projected.dailyPaceFormatted + "/day.");
        }
      }
      // Offer "log it now" button.
      const logIntent = {
        kind: "record_spend",
        params: { amountCents: result.amountCents, note: "" },
      };
      const token = setPending(state, logIntent);
      await db.saveState(prisma, u.id, state);
      // Decision flow buttons — the LLM judge flagged "No" as ambiguous
      // (reject the spend? reject the calculation?). "Skip" is unambiguous.
      const yesLabel = lang === "ru" ? "Записать" : "Log it";
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

    // ── DO (validated intent) ────────────────────
    if (result.kind === "do") {
      await db.appendHistory(prisma, u.id, "assistant", result.message);
      if (!result.verdict.ok) {
        await safeReply(ctx, "_" + m.escapeMd(result.verdict.reason) + "_", { parse_mode: "Markdown" });
        return;
      }
      const token = setPending(state, result.intent);
      await db.saveState(prisma, u.id, state);
      const card = describeIntent(result.intent, state);
      const intro = result.message ? result.message + "\n\n" : "";
      await safeReply(ctx, intro + card, {
        parse_mode: "Markdown",
        ...confirmKeyboard(token, lang),
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
        const lines = failItems.map(i => "_" + m.escapeMd(i.verdict.reason) + "_");
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
        ? "\n\n" + (lang === "ru" ? "_Пропущено:_" : "_Skipped:_") + "\n" + failItems.map(i => "  • " + m.escapeMd(i.verdict.reason)).join("\n")
        : "";
      const message = (result.message ? result.message + "\n\n" : "") + intro + "\n" + numbered.join("\n") + skippedLines;
      const yesLabel = lang === "ru" ? "Да, всё (" + intents.length + ")" : "Yes, all " + intents.length;
      const noLabel = lang === "ru" ? "Отмена" : "Cancel";
      await safeReply(ctx, message, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: yesLabel, callback_data: "yes:" + token },
            { text: noLabel,  callback_data: "no:"  + token },
          ]],
        },
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
      await safeReply(ctx, heroLineWithInsight(state, lang), { parse_mode: "Markdown" });
    }
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
        await safeReply(ctx, "_" + m.escapeMd(e.message) + "_", { parse_mode: "Markdown" });
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
    const url = process.env.MINIAPP_URL;
    if (!url) { await safeReply(ctx, "Mini app not configured."); return; }
    await safeReply(ctx, "Open the mini app:", {
      reply_markup: { inline_keyboard: [[{ text: "Open", web_app: { url } }]] },
    });
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
    await safeReply(ctx, lines.join("\n\n"), { parse_mode: "Markdown" });
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
        await safeReply(ctx, "_" + m.escapeMd(e.message) + "_", { parse_mode: "Markdown" });
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
        const v = require("./validator").validateIntent(state, intent, todayStr);
        if (!v.ok) { failed.push({ intent, reason: v.reason }); continue; }
        try {
          const r = applyIntent(state, intent);
          state = r.state;
          applied.push(intent);
        } catch (e) {
          failed.push({ intent, reason: e.message });
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
          ? "Сброшено ✅\n\nПривет, я *SpendYes* — твой денежный приятель. Я помогу следить за тратами, счетами и тем, сколько у тебя свободного времени до зарплаты.\n\nДавай начнём с начала: сколько примерно сейчас на счёте?"
          : "Reset ✅\n\nHi, I'm *SpendYes* — your money buddy. I'll help you keep tabs on spending, bills, and how much daily wiggle-room you have until payday.\n\nLet's start from scratch: what's roughly in your account?";
        await safeReply(ctx, welcome, { parse_mode: "Markdown" });
        return;
      }
      if (applied.length === 0) return;

      // Hero post-confirm: facts only. The auto-pushed insight after
      // every spend was noise — moved to pull-only (/today + AI question
      // replies) per user feedback. AAA brand register: quiet by default.
      await safeReply(ctx, heroLine(state, lang), { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[v5 confirm apply]", e);
      await safeEdit(ctx, "_" + m.escapeMd(e.message) + "_", Object.assign({ parse_mode: "Markdown" }, clearButtons));
    }
  });
}

// ── HANDLERS (grammy adapter) ────────────────────
function attach(prisma) {
  if (!bot) return;

  bot.command("start", (ctx) => processCommand(prisma, ctx, ctx.from.id, "start").catch(e => console.error("[v5 /start]", e)));
  bot.command("today", (ctx) => processCommand(prisma, ctx, ctx.from.id, "today").catch(e => console.error("[v5 /today]", e)));
  bot.command("undo",  (ctx) => processCommand(prisma, ctx, ctx.from.id, "undo").catch(e => console.error("[v5 /undo]", e)));
  bot.command("reset", (ctx) => processCommand(prisma, ctx, ctx.from.id, "reset").catch(e => console.error("[v5 /reset]", e)));
  bot.command("app",   (ctx) => processCommand(prisma, ctx, ctx.from.id, "app").catch(e => console.error("[v5 /app]", e)));
  bot.command("debug", (ctx) => processCommand(prisma, ctx, ctx.from.id, "debug").catch(e => console.error("[v5 /debug]", e)));

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
        const toSubunits = currency.convertSubunits(fromSubunits, p.originalCurrency, base);
        p.amountCents = toSubunits;
      }

      const v = require("./validator").validateIntent(state, r.intent, todayStr);
      if (!v.ok) {
        await safeReply(ctx, "_" + m.escapeMd(v.reason) + "_", { parse_mode: "Markdown" });
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
        ...confirmKeyboard(token, lang),
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
      const tr = await openai.audio.transcriptions.create({ file: audio, model: "whisper-1" }, { timeout: 15000 });
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

module.exports = { bot, attach, processText, processCommand, processCallbackData };
