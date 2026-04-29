"use strict";
// v4/bot.js — Telegram bot using v4 safe core.
// Confirm-card flow: every DO intent is shown to the user first; nothing
// applies until they tap "Yes" (or it's an auto-tier small spend with Undo).

const { Bot } = require("grammy");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const m = require("./model");
const { applyIntent } = require("./engine");
const { compute, heroLine: viewHeroLine } = require("./view");
const { processMessage } = require("./pipeline");
const proactive = require("./proactive");
const db = require("./db");
const { t, normalizeLang, defaultCurrencyForLang } = require("./locales");
const currency = require("./currency");

// updatePinnedStatus — keeps a single message pinned at the top of the
// chat showing the user's current hero state. Updated on every state
// change. Closes the "empty when I land" gap: regardless of how the
// user arrives at the chat, the baseline is at the top of the screen.
//
// Idempotent. Failsafe: if pinning is denied (rare in private chats),
// logs and continues — no user-visible error. The pinned message id
// lives in state.pinnedMessageId.
async function updatePinnedStatus(prisma, ctx, userId) {
  try {
    const state = await db.loadState(prisma, userId);
    if (!state.setup) return; // nothing to pin yet
    const lang = state.language || "en";
    const heroText = heroLine(state);
    if (!heroText) return;
    const text = "📌 " + heroText;
    const chatId = ctx.chat ? ctx.chat.id : (ctx.from && ctx.from.id);
    if (!chatId) return;

    if (state.pinnedMessageId) {
      // Edit the existing pinned message
      try {
        await ctx.api.editMessageText(chatId, state.pinnedMessageId, text, { parse_mode: "Markdown" });
        return;
      } catch (e) {
        // If edit fails (deleted, unpinned), fall through to re-create.
        const msg = (e && e.message) || "";
        if (!/not modified/i.test(msg)) {
          console.warn("[v4 pinned edit]", msg);
        } else {
          return;
        }
      }
    }
    // Create + pin a fresh status message
    try {
      const sent = await ctx.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
      try { await ctx.api.pinChatMessage(chatId, sent.message_id, { disable_notification: true }); }
      catch (e) { console.warn("[v4 pin]", e && e.message); }
      state.pinnedMessageId = sent.message_id;
      await db.saveState(prisma, userId, state);
    } catch (e) {
      console.warn("[v4 pin send]", e && e.message);
    }
  } catch (e) {
    // Pinning is best-effort. Never break a flow over it.
    console.warn("[v4 updatePinnedStatus]", e && e.message);
  }
}

// renderVerdict — the seam between engineering rules and user voice.
// The validator emits a machine-readable { code, context }; this wraps
// it in t() to produce a conversational, locale-aware sentence. Schema
// vocabulary never reaches the user.
function renderVerdict(verdict, lang) {
  if (!verdict) return "";
  if (verdict.code) return t("v." + verdict.code, lang || "en", verdict.context || {});
  return verdict.reason || ""; // legacy fallback for anything still using strings
}

// Detect & commit the user's locale on first contact. Called at the top
// of every text/voice handler. Idempotent — only writes state on the
// FIRST turn (when state.language is still the engine default "en" AND
// the Telegram client signals a different language).
//
// We trust ctx.from.language_code as the canonical signal (Telegram's
// device locale). User can override anytime in chat with "switch to X".
async function commitTelegramLocale(prisma, ctx, userId) {
  try {
    const tgLang = (ctx.from && ctx.from.language_code) || "";
    if (!tgLang) return null;
    const lang = normalizeLang(tgLang);
    const state = await db.loadState(prisma, userId);
    // Only commit on a fresh state (never set up yet, no envelopes, no txs).
    // After the user starts using the bot, language is stable.
    const isVirgin = !state.setup
      && (!state.transactions || state.transactions.length === 0)
      && Object.keys(state.envelopes || {}).length === 0;
    if (!isVirgin) return state.language || "en";
    if (state.language === lang) return lang; // already committed
    state.language = lang;
    const def = defaultCurrencyForLang(lang);
    state.currency = def.code;
    state.currencySymbol = def.symbol;
    await db.saveState(prisma, userId, state);
    return lang;
  } catch (e) {
    console.warn("[v4 commitTelegramLocale]", e.message);
    return null;
  }
}

// Per-context language helper: load state, return state.language or fallback to "en".
async function userLang(prisma, telegramId) {
  try {
    const u = await db.resolveUser(prisma, "tg_" + telegramId);
    const state = await db.loadState(prisma, u.id);
    return state.language || "en";
  } catch { return "en"; }
}

// Trim BOT_TOKEN — Railway/.env paste often leaves a trailing newline which
// silently breaks initData HMAC validation while still working for API calls.
const BOT_TOKEN_RAW = process.env.BOT_TOKEN || "";
const BOT_TOKEN = BOT_TOKEN_RAW.trim();
if (BOT_TOKEN_RAW && BOT_TOKEN_RAW !== BOT_TOKEN) {
  console.warn("[v4] BOT_TOKEN had trailing whitespace — trimmed");
}
const bot = BOT_TOKEN ? new Bot(BOT_TOKEN) : null;
const openai = new OpenAI();

// In-memory pending intents store: { token → { userId, intent, expires } }.
// Confirm cards include a token in the callback_data; max ~30 min TTL.
const PENDING_TTL_MS = 30 * 60 * 1000;
const pending = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 60_000);

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Pending intents are now stored as an array so a batch card can apply
// multiple intents on a single Yes. Single-intent callers pass [intent].
// A pending entry can carry a queue. When the user taps Yes on a queued
// confirm, the bot applies the current intent then advances to the next
// item in the queue, presenting a fresh confirm card with "(idx+1) of N".
function setPending(intents, userId, opts) {
  const arr = Array.isArray(intents) ? intents : [intents];
  const token = makeToken();
  pending.set(token, {
    intents: arr,                            // the intents being confirmed by THIS card
    queueAfter: (opts && opts.queueAfter) || null,  // remaining intents to process
    queueTotal: (opts && opts.queueTotal) || arr.length,
    queueIndex: (opts && opts.queueIndex) || 1,
    originalMessage: (opts && opts.originalMessage) || null,
    userId,
    expires: Date.now() + PENDING_TTL_MS,
  });
  return token;
}

// Undo tokens — separate map. Tied to a specific event id so a stale undo
// (after other actions happened) can be detected and refused gracefully.
const UNDO_TTL_MS = 30 * 60 * 1000;
const undoTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of undoTokens) if (v.expires < now) undoTokens.delete(k);
}, 60_000);

function setUndoToken(eventId, userId) {
  const token = makeToken();
  undoTokens.set(token, { eventId, userId, expires: Date.now() + UNDO_TTL_MS });
  return token;
}

function takeUndoToken(token) {
  const e = undoTokens.get(token);
  if (!e) return null;
  undoTokens.delete(token);
  return e;
}

function undoButton(token, lang) {
  return { reply_markup: { inline_keyboard: [[{ text: t("undo.button", lang || "en"), callback_data: "undo:" + token }]] } };
}

function takePending(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  return entry;
}

// ── HELPERS ─────────────────────────────────────────────
// fmtIntent renders a short user-facing description of an intent for the
// confirm card. Localized via t(). User-supplied strings (envelope
// names, notes) are escaped for Markdown to prevent silent message drops
// from unbalanced * / _ / ` / [ ] characters.
function fmtIntent(intent, opts) {
  const p = intent.params || {};
  const lang = (opts && opts.lang) || "en";
  const sym = (opts && opts.sym) || "$";
  const baseCode = (opts && opts.currencyCode) || "USD";
  const M = (c) => currency.fmtMoney(typeof c === "number" ? c : 0, baseCode);
  // Shorthand for escaping user-supplied strings against Markdown breakage.
  const E = m.escapeMd;
  // User-controlled fields run through E. Numeric/symbol fields (which
  // we generate) pass through directly.
  const eName = E(p.name);
  const eNote = E(p.note);
  const eEnvKey = E(p.envelopeKey || p.key);
  const fmtAmtPair = (cents) => {
    if (typeof p.originalAmountCents === "number" && p.originalCurrency
        && p.originalCurrency !== baseCode) {
      return currency.fmtMoney(p.originalAmountCents, p.originalCurrency)
        + " (≈" + currency.fmtMoney(cents, baseCode) + ")";
    }
    return M(cents);
  };

  const recurrenceWord = (rec) => {
    if (!rec || rec === "once") return null;
    return t("recurrence." + rec, lang);
  };

  switch (intent.kind) {
    case "setup_account":
      return t("intent.setup", lang, {
        balance: M(p.balanceCents),
        paydayClause: p.payday ? ", " + p.payday : "",
        freqClause: p.payFrequency ? ", " + p.payFrequency : "",
      });
    case "adjust_balance":
      return t("intent.adjust", lang, { balance: M(p.newBalanceCents) });
    case "add_envelope": {
      const recur = recurrenceWord(p.recurrence);
      const recurrenceClause = recur ? " · " + recur : "";
      const dueClause = p.dueDate ? " · " + p.dueDate : "";
      if (p.kind === "bill") {
        return t("intent.addBill", lang, {
          name: eName, amount: M(p.amountCents), recurrenceClause, dueClause,
        });
      }
      if (p.kind === "budget") {
        return t("intent.addBudget", lang, { name: eName, amount: M(p.amountCents) });
      }
      if (p.kind === "goal") {
        const targetClause = p.targetCents ? " · target " + M(p.targetCents) : "";
        return t("intent.addGoal", lang, { name: eName, amount: M(p.amountCents), targetClause });
      }
      return t("intent.unknown", lang, { kind: intent.kind });
    }
    case "update_envelope":
      return t("intent.update", lang, { name: eName || eEnvKey });
    case "remove_envelope":
      return t("intent.remove", lang, { name: eName || eEnvKey });
    case "record_spend": {
      const noteClause = p.note ? " · " + eNote : "";
      const envelopeClause = "";
      const isForeign = typeof p.originalAmountCents === "number" && p.originalCurrency
        && p.originalCurrency !== baseCode;
      if (isForeign) {
        return t("intent.spendForeign", lang, {
          originalAmount: currency.fmtMoney(p.originalAmountCents, p.originalCurrency),
          amount: M(p.amountCents),
          noteClause, envelopeClause,
        });
      }
      return t("intent.spend", lang, { amount: M(p.amountCents), noteClause, envelopeClause });
    }
    case "record_income":
      return t("intent.income", lang, { amount: M(p.amountCents), noteClause: p.note ? " · " + eNote : "" });
    case "fund_envelope":
      return t("intent.fundEnvelope", lang, { amount: M(p.amountCents), name: eName || eEnvKey });
    case "pay_bill":
      return t("intent.payBill", lang, { name: eName || eEnvKey });
    case "skip_bill":
      return t("intent.skipBill", lang, { name: eName || eEnvKey });
    case "edit_transaction":
      return t("intent.editTx", lang, { amount: p.newAmountCents !== undefined ? M(p.newAmountCents) : "" });
    case "delete_transaction":
      return t("intent.deleteTx", lang);
    case "update_settings":
      return t("intent.updateSettings", lang);
    case "reset":
      return t("intent.reset", lang);
    default:
      return t("intent.unknown", lang, { kind: intent.kind });
  }
}

// Localized hero line. For English, uses the day-stable variant pool from
// view.js. For other languages, emits a single calibrated template per state.
function heroLine(state) {
  const v = compute(state);
  if (!v.setup) return "";
  const lang = state.language || "en";
  const baseCode = state.currency || "USD";
  if (lang === "en") return viewHeroLine(v, m.today(state.timezone || "UTC"));
  // Replace the formatted amounts on the view with current-base-currency
  // formatted versions (view.dailyPaceFormatted may use a different symbol).
  const dailyFmt = currency.fmtMoney(v.dailyPaceCents, baseCode);
  const deficitFmt = currency.fmtMoney(v.deficitCents, baseCode);
  if (v.state === "over") {
    return "🔴 *" + t("status.over", lang) + "* — " + deficitFmt;
  }
  if (v.state === "tight") {
    return "🟡 *" + t("status.tight", lang) + "* — " + dailyFmt + (lang === "ru" ? "/день · " : "/day · ") + v.daysToPayday + (lang === "ru" ? " дн" : " days");
  }
  return "🟢 *" + t("status.calm", lang) + "* — " + dailyFmt + (lang === "ru" ? "/день · " : "/day · ") + v.daysToPayday + (lang === "ru" ? " дн до зарплаты" : " days to payday");
}

// Reply keyboard is dead weight: it eats screen space on every message,
// looks dated, and is redundant with the always-visible ≡ menu button.
// Modern Telegram money bots don't use them. We send remove_keyboard with
// every reply so existing users see their old keyboard disappear, and new
// users never see one. Inline keyboards are still used for confirm cards.
function mainKeyboard() {
  return { remove_keyboard: true };
}

// Greeting patterns: deterministic intercept for fresh users who say
// hi/hello/hey/etc. (English + Russian + universal). Bypasses the AI
// entirely so the response is reliable.
const GREETING_PATTERNS = /^\s*(hi+|hello+|hey+|yo+|sup|hola|namaste|howdy|hii+|heya|good\s*(morning|afternoon|evening|day|night)|what['s ]*up|h r u|hru|привет|здравствуй(те)?|добрый\s*(день|утро|вечер)|здарова|hellooo)\s*[!.?]*\s*$/i;

// Welcome — refresh + confidence + ask. Three lines. Localized.
// Used on /start (fresh user), greeting intercept, and post-reset.
function welcomeMessage(lang, opts) {
  const fresh = !!(opts && opts.afterReset);
  const ask = fresh ? t("welcome.afterReset", lang) : t("welcome.askBalance", lang);
  return t("welcome.identity", lang) + "\n\n" + t("welcome.value", lang) + "\n\n" + ask;
}

function confirmCard(token, opts) {
  const yesLabel = (opts && opts.yesLabel) || "Yes, do it";
  const noLabel = (opts && opts.noLabel) || "Cancel";
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: yesLabel, callback_data: "yes:" + token },
        { text: noLabel, callback_data: "no:" + token },
      ]],
    },
  };
}

// safeReply / safeEdit — Telegram silently DROPS messages with malformed
// Markdown (unbalanced * or _ from user input that escaped the escaping
// layer). These wrappers retry once without parse_mode if the first
// attempt errors with "can't parse entities". Failures beyond that are
// logged loudly so we can fix the markdown source.
async function safeReply(ctx, text, options) {
  try {
    return await ctx.reply(text, options || {});
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/can't parse|parse_mode/i.test(msg) && options && options.parse_mode) {
      // Retry without parse_mode — preserve everything else.
      const fallbackOpts = Object.assign({}, options);
      delete fallbackOpts.parse_mode;
      try {
        const sent = await ctx.reply(text, fallbackOpts);
        console.warn("[v4 safeReply] markdown failed, sent as plain:", msg, "// text:", text.slice(0, 200));
        return sent;
      } catch (e2) {
        console.error("[v4 safeReply] retry failed:", e2.message);
      }
    } else {
      console.error("[v4 safeReply]", msg);
    }
    return null;
  }
}

async function safeEdit(ctx, text, options) {
  try {
    return await ctx.editMessageText(text, options || {});
  } catch (e) {
    const msg = (e && e.message) || "";
    // Common "message is not modified" — Telegram rejects identical edits.
    // Treat as success; the visual state is already correct.
    if (/not modified/i.test(msg)) return null;
    if (/can't parse|parse_mode/i.test(msg) && options && options.parse_mode) {
      const fallbackOpts = Object.assign({}, options);
      delete fallbackOpts.parse_mode;
      try {
        return await ctx.editMessageText(text, fallbackOpts);
      } catch (e2) {
        console.error("[v4 safeEdit] retry failed:", e2.message);
      }
    } else {
      console.warn("[v4 safeEdit]", msg);
    }
    return null;
  }
}

// Voice playback (TTS) was removed per user feedback — voice input
// (Whisper) stays, but the bot does not speak back. This helper is now
// a thin wrapper around safeReply for back-compat with existing call sites.
async function sayMaybeVoice(ctx, text, options /*, voiceMode unused */) {
  return safeReply(ctx, text, options || {});
}

// ── PROCESS A USER TEXT MESSAGE ────────────────────────
async function processText(prisma, ctx, telegramId, text, opts) {
  const isVoice = !!(opts && opts.isVoice);
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  await ctx.replyWithChatAction("typing");

  await db.withUserLock(u.id, async () => {
    const state = await db.loadState(prisma, u.id);
    const history = await db.loadHistory(prisma, u.id);
    const voiceMode = isVoice && !!state.voiceReplies;
    const lang = state.language || "en";
    const baseCode = state.currency || "USD";
    const sym = state.currencySymbol || "$";
    const fmtOpts = { lang, sym, currencyCode: baseCode };

    const result = await processMessage(state, text, history);

    // Persist conversation history (talk and do both).
    await db.appendHistory(prisma, u.id, "user", text);
    if (result.message) await db.appendHistory(prisma, u.id, "assistant", result.message);

    if (result.kind === "talk") {
      await sayMaybeVoice(ctx, result.message || "…", {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard(),
      }, voiceMode);
      return;
    }

    // DECISION SUPPORT: read-only simulate. Show projected hero + delta,
    // offer "Log it now" button that converts to a real record_spend confirm.
    if (result.kind === "decision") {
      const sim = result.simulate;
      const proj = sim.projected;
      const cur = sim.current;
      const M = c => currency.fmtMoney(c, baseCode);
      const amt = result.intent.params.amountCents;
      const dailyFmt = (s) => currency.fmtMoney(s.dailyPaceCents || 0, baseCode);

      // Localized verdict copy. Keep tight; keep numerical authority.
      let verdict;
      if (proj.state === "over") {
        verdict = (lang === "ru" ? "*Перерасход.* Это даст " : "*Over.* That'd put you ") + M(proj.deficitCents) + (lang === "ru" ? " дефицита в этом периоде." : " over for the cycle.");
      } else if (proj.state === "tight") {
        verdict = (lang === "ru" ? "*Впритык.* Останется " : "*Tight.* You'd drop to ") + dailyFmt(proj) + (lang === "ru" ? "/день на " + proj.daysToPayday + " дн." : "/day for " + proj.daysToPayday + " days.");
      } else if (cur.state !== "green") {
        verdict = (lang === "ru" ? "*Спокойнее.* Вернёт к " : "*Green.* You'd jump from ") + dailyFmt(cur) + (lang === "ru" ? "/день → " : "/day up to ") + dailyFmt(proj) + "/day.";
      } else {
        verdict = (lang === "ru" ? "*Спокойно.* Останется " : "*Easy.* You'd still have ") + dailyFmt(proj) + (lang === "ru" ? "/день на " + proj.daysToPayday + " дн." : "/day for " + proj.daysToPayday + " days.");
      }

      const lines = [];
      if (result.message) lines.push(result.message);
      lines.push("");
      lines.push(verdict);
      lines.push("_" + (lang === "ru" ? "Трата: " : "Spend: ") + M(amt) + (result.intent.params.note ? (lang === "ru" ? " на " : " on ") + result.intent.params.note : "") + "_");

      const recordIntent = {
        kind: "record_spend",
        params: {
          amountCents: amt,
          note: result.intent.params.note || "",
          envelopeKey: result.intent.params.envelopeKey || null,
        },
      };
      const token = setPending([recordIntent], u.id);
      const yesLabel = lang === "ru" ? "Записать сейчас" : "Log it now";
      const noLabel = lang === "ru" ? "Пропустить" : "Skip";
      await ctx.reply(lines.join("\n"), {
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

    // DO mode: bucket decisions by severity.
    let curState = state;
    const autoApplied = [];
    const toConfirm = [];
    const rejections = [];

    for (const d of result.decisions) {
      if (!d.verdict.ok) {
        rejections.push(renderVerdict(d.verdict, lang));
        continue;
      }
      if (d.verdict.severity === "auto") {
        try {
          const r = applyIntent(curState, d.intent);
          curState = r.state;
          autoApplied.push(d.intent);
        } catch (e) {
          rejections.push(t("error.couldntLog", lang, { error: e.message }));
        }
        continue;
      }
      toConfirm.push({ intent: d.intent, verdict: d.verdict });
    }

    if (autoApplied.length > 0) await db.saveState(prisma, u.id, curState);

    if (rejections.length > 0) {
      const txt = (result.message ? result.message + "\n\n" : "")
        + rejections.map(r => "_" + m.escapeMd(r) + "_").join("\n");
      await safeReply(ctx, txt, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    }

    if (autoApplied.length > 0) {
      const lines = autoApplied.map(i => "✓ " + fmtIntent(i, fmtOpts));
      lines.push(heroLine(curState));
      const lastEventId = curState.events && curState.events.length
        ? curState.events[curState.events.length - 1].id
        : null;
      const replyOpts = { parse_mode: "Markdown", reply_markup: mainKeyboard() };
      if (lastEventId) {
        const undoTok = setUndoToken(lastEventId, u.id);
        replyOpts.reply_markup = undoButton(undoTok, lang).reply_markup;
      }
      await sayMaybeVoice(ctx, lines.join("\n"), replyOpts, voiceMode);
    }

    if (toConfirm.length === 1) {
      const { intent, verdict } = toConfirm[0];
      const queueAfter = result.queueAfter || null;
      const queueTotal = result.queueTotal || 1;
      const queueIndex = result.queueIndex || 1;

      const token = setPending([intent], u.id, { queueAfter, queueTotal, queueIndex });

      // Only show "Step N of M" when there's actually a sequence. For
      // solo confirms the card is conversational, not procedural.
      const stepLabel = queueTotal > 1 ? "*" + t("confirm.stepOf", lang, { n: queueIndex, m: queueTotal }) + "*\n" : "";
      const intro = (result.message && rejections.length === 0 && autoApplied.length === 0)
        ? result.message + "\n\n" : "";

      const renderedReason = renderVerdict(verdict, lang);
      // Skip the rendered hint if it's empty or duplicates the generic
      // "set this up?" — the fmtIntent line already says it.
      const showReason = renderedReason && !/set this up\?|настроить\?/i.test(renderedReason);
      const cardText = intro + stepLabel
        + fmtIntent(intent, fmtOpts)
        + (showReason ? "\n_" + m.escapeMd(renderedReason) + "_" : "");

      const yesLabel = queueTotal > 1 ? t("confirm.next", lang) : t("confirm.yes", lang);
      const noLabel = queueTotal > 1 ? t("confirm.skip", lang) : t("confirm.cancel", lang);
      await safeReply(ctx, cardText, { parse_mode: "Markdown", ...confirmCard(token, { yesLabel, noLabel }) });
    } else if (toConfirm.length > 1) {
      const intents = toConfirm.map(c => c.intent);
      const token = setPending(intents, u.id);
      const intro = lang === "ru" ? "*Хочу:*" : "*I'd like to:*";
      const confirmAll = lang === "ru" ? "_Подтвердить всё?_" : "_Confirm all?_";
      const lines = [intro];
      intents.forEach((i, idx) => lines.push((idx + 1) + ". " + fmtIntent(i, fmtOpts)));
      lines.push("");
      lines.push(confirmAll);
      await safeReply(ctx, lines.join("\n"), {
        parse_mode: "Markdown",
        ...confirmCard(token, { yesLabel: t("confirm.yes", lang), noLabel: t("confirm.cancel", lang) }),
      });
    }

    if (rejections.length === 0 && autoApplied.length === 0 && toConfirm.length === 0 && result.message) {
      // Edge case: AI in "do" mode but everything got dropped — fall back to talk.
      await ctx.reply(result.message, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    }
  });

  // Refresh pinned status (best-effort, never blocks the user-facing flow).
  updatePinnedStatus(prisma, ctx, u.id).catch(() => {});
}

// ── HANDLERS ───────────────────────────────────────────
function attach(prisma) {
  if (!bot) return;

  bot.command("start", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await commitTelegramLocale(prisma, ctx, u.id);
      const state = await db.loadState(prisma, u.id);
      const lang = state.language || "en";
      if (!state.setup) {
        await ctx.reply(welcomeMessage(lang), {
          parse_mode: "Markdown",
          reply_markup: mainKeyboard(),
        });
      } else {
        await ctx.reply(heroLine(state), {
          parse_mode: "Markdown",
          reply_markup: mainKeyboard(),
        });
      }
    } catch (e) {
      console.error("[v4 /start]", e);
      await ctx.reply(t("error.couldntStart", "en")).catch(() => {});
    }
  });

  bot.command("mute", async (ctx) => {
    try {
      const lang = await userLang(prisma, ctx.from.id);
      const arg = (ctx.match || "").toString().trim().toLowerCase();
      const valid = ["bills", "pace", "milestones", "all"];
      if (!valid.includes(arg)) {
        await ctx.reply(t("mute.usage", lang), { parse_mode: "Markdown" });
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.mute) state.mute = {};
        if (arg === "all") {
          state.mute.bills = state.mute.pace = state.mute.milestones = true;
        } else {
          state.mute[arg] = true;
        }
        await db.saveState(prisma, u.id, state);
        await ctx.reply(t("mute.muted", lang, { what: arg }), { parse_mode: "Markdown" });
      });
    } catch (e) {
      console.error("[v4 /mute]", e);
      await ctx.reply(t("mute.couldnt", await userLang(prisma, ctx.from.id))).catch(() => {});
    }
  });

  bot.command("unmute", async (ctx) => {
    try {
      const lang = await userLang(prisma, ctx.from.id);
      const arg = (ctx.match || "").toString().trim().toLowerCase();
      const valid = ["bills", "pace", "milestones", "all"];
      if (!valid.includes(arg)) {
        await ctx.reply(t("mute.unmuteUsage", lang), { parse_mode: "Markdown" });
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.mute) state.mute = {};
        if (arg === "all") {
          state.mute.bills = state.mute.pace = state.mute.milestones = false;
        } else {
          state.mute[arg] = false;
        }
        await db.saveState(prisma, u.id, state);
        await ctx.reply(t("mute.unmuted", lang, { what: arg }));
      });
    } catch (e) {
      console.error("[v4 /unmute]", e);
      await ctx.reply(t("mute.couldnt", await userLang(prisma, ctx.from.id))).catch(() => {});
    }
  });

  // /voice command removed: voice playback is gone. Voice INPUT
  // (sending the bot a voice note) is still supported.

  bot.command("today", async (ctx) => {
    try {
      const lang = await userLang(prisma, ctx.from.id);
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      if (!state.setup) {
        await ctx.reply(t("today.notSetUp", lang), { reply_markup: mainKeyboard() });
        return;
      }
      // Just the hero. Nothing else. The daily ritual.
      await ctx.reply(heroLine(state), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    } catch (e) {
      console.error("[v4 /today]", e);
      await ctx.reply(t("today.couldntLoad", await userLang(prisma, ctx.from.id))).catch(() => {});
    }
  });

  bot.command("help", async (ctx) => {
    const lang = await userLang(prisma, ctx.from.id);
    const lines = [
      t("help.intro", lang),
      "",
      "*" + t("help.commands.title", lang) + "*",
      t("help.commands.start", lang),
      t("help.commands.today", lang),
      t("help.commands.app", lang),
      t("help.commands.undo", lang),
      t("help.commands.mute", lang),
      t("help.commands.reset", lang),
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
  });

  bot.command("undo", async (ctx) => {
    try {
      const lang = await userLang(prisma, ctx.from.id);
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.setup || !Array.isArray(state.events) || state.events.length <= 1) {
          await ctx.reply(t("undo.nothingYet", lang), { reply_markup: mainKeyboard() });
          return;
        }
        const last = state.events[state.events.length - 1];
        if (last && last.intent && last.intent.kind === "setup_account") {
          await ctx.reply(t("undo.cantUndoSetup", lang), { reply_markup: mainKeyboard() });
          return;
        }
        try {
          const r = applyIntent(state, { kind: "undo_last", params: {} });
          await db.saveState(prisma, u.id, r.state);
          const undidIntent = r.event.undid && r.event.undid.intent;
          const desc = undidIntent
            ? fmtIntent(undidIntent, { lang, sym: r.state.currencySymbol, currencyCode: r.state.currency })
            : t("intent.unknown", lang, { kind: "" });
          await ctx.reply(t("undo.undone", lang, { what: desc }) + "\n" + heroLine(r.state), {
            parse_mode: "Markdown",
            reply_markup: mainKeyboard(),
          });
          updatePinnedStatus(prisma, ctx, u.id).catch(() => {});
        } catch (e) {
          await ctx.reply(t("undo.couldnt", lang, { error: e.message })).catch(() => {});
        }
      });
    } catch (e) {
      console.error("[v4 /undo]", e);
      await ctx.reply(t("error.somethingWrong", await userLang(prisma, ctx.from.id))).catch(() => {});
    }
  });

  bot.command("app", async (ctx) => {
    const lang = await userLang(prisma, ctx.from.id);
    const url = process.env.MINIAPP_URL;
    if (!url) return ctx.reply(t("app.notConfigured", lang));
    await ctx.reply(t("app.openIntro", lang), {
      reply_markup: {
        inline_keyboard: [[{ text: t("app.openButton", lang), web_app: { url } }]],
      },
    });
  });

  bot.command("reset", async (ctx) => {
    const lang = await userLang(prisma, ctx.from.id);
    const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
    const token = setPending([{ kind: "reset", params: {} }], u.id);
    await ctx.reply(t("reset.confirm", lang), {
      ...confirmCard(token, { yesLabel: t("reset.confirmYes", lang), noLabel: t("reset.cancel", lang) }),
    });
  });

  bot.hears(/^(How am I doing\?|how am i doing)/i, async (ctx) => {
    await processText(prisma, ctx, ctx.from.id, "How am I doing?");
  });

  bot.on("message:text", async (ctx) => {
    try {
      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return; // commands handled above
      // Lang resolution: commit Telegram client locale on first contact.
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const lang = (await commitTelegramLocale(prisma, ctx, u.id)) || "en";
      if (text.length > 2000) return ctx.reply(t("error.tooLong", lang));

      // Deterministic onboarding intercept: fresh users sending a greeting
      // get a hardcoded warm welcome that asks for balance.
      if (GREETING_PATTERNS.test(text)) {
        const state = await db.loadState(prisma, u.id);
        if (!state.setup) {
          await ctx.reply(welcomeMessage(state.language || lang), {
            parse_mode: "Markdown",
            reply_markup: mainKeyboard(),
          });
          return;
        }
      }

      await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v4 text]", e);
      const lang = await userLang(prisma, ctx.from.id);
      await ctx.reply(t("error.generic", lang)).catch(() => {});
    }
  });

  bot.on("message:voice", async (ctx) => {
    const lang = await userLang(prisma, ctx.from.id);
    if (!process.env.OPENAI_API_KEY) return ctx.reply(t("error.voiceDisabled", lang));
    let statusMsg;
    try { statusMsg = await ctx.reply("🎙"); } catch {}
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      await commitTelegramLocale(prisma, ctx, u.id);
      const file = await ctx.getFile();
      const url = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, { signal: ctrl.signal });
      const buf = Buffer.from(await resp.arrayBuffer());
      clearTimeout(tt);
      const audioFile = await toFile(buf, "voice.ogg", { type: "audio/ogg" });
      const tr = await openai.audio.transcriptions.create({ file: audioFile, model: "whisper-1" }, { timeout: 15000 });
      const text = (tr.text || "").slice(0, 2000);
      if (statusMsg) ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      if (!text) return ctx.reply(t("error.couldntCatch", lang));
      await processText(prisma, ctx, ctx.from.id, text, { isVoice: true });
    } catch (e) {
      console.error("[v4 voice]", e);
      const langLatest = await userLang(prisma, ctx.from.id);
      if (statusMsg) ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, t("error.voiceProcessing", langLatest)).catch(() => {});
      else ctx.reply(t("error.voiceProcessing", langLatest)).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      // Undo button — independent flow from confirm tokens.
      if (data.startsWith("undo:")) {
        const token = data.slice(5);
        const entry = takeUndoToken(token);
        const lang = await userLang(prisma, ctx.from.id);
        if (!entry) {
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.reply(t("undo.expired", lang), { reply_markup: mainKeyboard() }).catch(() => {});
          return;
        }
        const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
        if (entry.userId !== u.id) {
          await ctx.reply(t("undo.notYours", lang)).catch(() => {});
          return;
        }
        await db.withUserLock(u.id, async () => {
          const state = await db.loadState(prisma, u.id);
          const stateLang = state.language || "en";
          const fmtOpts = { lang: stateLang, sym: state.currencySymbol, currencyCode: state.currency };
          const last = state.events && state.events.length ? state.events[state.events.length - 1] : null;
          if (!last || last.id !== entry.eventId) {
            await ctx.reply(t("undo.staleSinceOthers", stateLang), { reply_markup: mainKeyboard() }).catch(() => {});
            return;
          }
          try {
            const r = applyIntent(state, { kind: "undo_last", params: {} });
            await db.saveState(prisma, u.id, r.state);
            const undidIntent = r.event.undid && r.event.undid.intent;
            const desc = undidIntent ? fmtIntent(undidIntent, fmtOpts) : t("intent.unknown", stateLang, { kind: "" });
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
            await ctx.reply(t("undo.undone", stateLang, { what: desc }) + "\n" + heroLine(r.state),
              { parse_mode: "Markdown", reply_markup: mainKeyboard() }).catch(() => {});
            updatePinnedStatus(prisma, ctx, u.id).catch(() => {});
          } catch (e) {
            await ctx.reply(t("undo.couldnt", stateLang, { error: e.message })).catch(() => {});
          }
        });
        return;
      }

      if (!data.startsWith("yes:") && !data.startsWith("no:")) return;
      const isYes = data.startsWith("yes:");
      const token = data.slice(4);
      const entry = takePending(token);
      const lang = await userLang(prisma, ctx.from.id);
      if (!entry) {
        await ctx.editMessageText(t("confirm.expired", lang)).catch(() => {});
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      if (entry.userId !== u.id) {
        await ctx.editMessageText(t("confirm.notYours", lang)).catch(() => {});
        return;
      }
      if (!isYes) {
        const wasInQueue = entry.queueAfter && entry.queueAfter.length > 0;
        await ctx.editMessageText(wasInQueue ? t("confirm.queueStopped", lang) : t("confirm.cancelled", lang)).catch(() => {});
        return;
      }
      // Yes → apply each pending intent in order under one lock.
      // Then, if a queue exists, present the NEXT confirm card.
      await db.withUserLock(u.id, async () => {
        let state = await db.loadState(prisma, u.id);
        const stateLang = state.language || "en";
        const fmtOpts = { lang: stateLang, sym: state.currencySymbol, currencyCode: state.currency };
        const applied = [];
        try {
          for (const intent of entry.intents) {
            const r = applyIntent(state, intent);
            state = r.state;
            applied.push(intent);
          }
          await db.saveState(prisma, u.id, state);
          const wasReset = applied.some(i => i && i.kind === "reset");

          if (wasReset) {
            // Re-load state after reset (currency/language may have been wiped).
            const fresh = await db.loadState(prisma, u.id);
            const langAfter = fresh.language || stateLang;
            await ctx.editMessageText(t("reset.done", langAfter), { parse_mode: "Markdown" }).catch(() => {});
            await ctx.reply(welcomeMessage(langAfter, { afterReset: true }), {
              parse_mode: "Markdown",
              reply_markup: mainKeyboard(),
            });
            await db.appendHistory(prisma, u.id, "system", "[user reset — fresh start]").catch(() => {});
            return;
          }

          const lines = applied.map(i => "✓ " + fmtIntent(i, fmtOpts));

          let nextQueue = (entry.queueAfter || []).slice();
          let nextIndex = (entry.queueIndex || 1) + 1;
          const total = entry.queueTotal || 1;
          let nextConfirmIntent = null;
          let nextConfirmVerdict = null;
          const queueRejections = [];

          while (nextQueue.length > 0) {
            const candidate = nextQueue.shift();
            const verdict = validateIntent(state, candidate, m.today(state.timezone || "UTC"));
            if (!verdict.ok) {
              queueRejections.push((stateLang === "ru" ? "Пропущено: " : "Skipped: ") + renderVerdict(verdict, stateLang));
              nextIndex++;
              continue;
            }
            if (verdict.severity === "auto") {
              try {
                const r = applyIntent(state, candidate);
                state = r.state;
                applied.push(candidate);
                nextIndex++;
              } catch (e) {
                queueRejections.push(t("error.couldntLog", stateLang, { error: e.message }));
                nextIndex++;
              }
              continue;
            }
            nextConfirmIntent = candidate;
            nextConfirmVerdict = verdict;
            break;
          }

          if (applied.length > entry.intents.length) {
            await db.saveState(prisma, u.id, state);
          }

          // Sanitize rejection text for markdown italics (validator now
          // emits plain text but defense in depth — escape user fragments
          // that may have leaked through as part of an error message).
          const summary = lines.concat(queueRejections.map(r => "_" + m.escapeMd(r) + "_")).join("\n");
          await safeEdit(ctx, summary, { parse_mode: "Markdown" });

          if (nextConfirmIntent) {
            const newToken = setPending([nextConfirmIntent], u.id, {
              queueAfter: nextQueue,
              queueTotal: total,
              queueIndex: nextIndex,
            });
            const stepLabel = "*" + t("confirm.stepOf", stateLang, { n: nextIndex, m: total }) + "*\n";
            const cardText = stepLabel + fmtIntent(nextConfirmIntent, fmtOpts) +
              ((function() {
                const rr = renderVerdict(nextConfirmVerdict, stateLang);
                return rr && !/set this up\?|настроить\?/i.test(rr) ? "\n_" + m.escapeMd(rr) + "_" : "";
              })());
            const yesLabel = (nextIndex < total) ? t("confirm.next", stateLang) : t("confirm.yes", stateLang);
            const noLabel = t("confirm.skip", stateLang);
            await safeReply(ctx, cardText, { parse_mode: "Markdown", ...confirmCard(newToken, { yesLabel, noLabel }) });
            return;
          }

          const lastEventId = state.events && state.events.length
            ? state.events[state.events.length - 1].id
            : null;
          // Self-contained acknowledgment: intent recap + warm preamble +
          // hero. The user gets a clear bot-reply even if the card edit
          // above silently failed. This is the "post-confirm" message.
          const ackPreamble = total > 1
            ? t("confirm.allSet", stateLang)
            : t("confirm.done", stateLang);
          // Re-render the most recently applied intent as the recap line.
          const lastApplied = applied.length > 0 ? applied[applied.length - 1] : null;
          const recapLine = lastApplied ? "✓ " + fmtIntent(lastApplied, fmtOpts) : "";
          const finalLines = [];
          if (recapLine) finalLines.push(recapLine);
          finalLines.push(ackPreamble);
          finalLines.push(heroLine(state));
          const finalOpts = { parse_mode: "Markdown" };
          if (lastEventId) {
            finalOpts.reply_markup = undoButton(setUndoToken(lastEventId, u.id), stateLang).reply_markup;
          }
          await safeReply(ctx, finalLines.filter(Boolean).join("\n"), finalOpts);
          updatePinnedStatus(prisma, ctx, u.id).catch(() => {});
        } catch (e) {
          console.error("[v4 confirm apply]", e);
          await ctx.editMessageText(t("confirm.couldntApply", stateLang, { error: e.message })).catch(() => {});
        }
      });
    } catch (e) {
      console.error("[v4 callback]", e);
    }
  });
}

// ── PROACTIVE SCHEDULER ─────────────────────────────────
// Runs every hour. Fires only at 9 AM user-local. Hard rate-limit: 1
// proactive message per user per ~24 hours, even if multiple eligible.
const PROACTIVE_HOUR = 9;
const PROACTIVE_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

async function runProactive(prisma) {
  if (!bot) return;
  let users;
  try {
    users = await prisma.user.findMany({
      where: { telegramId: { not: null } },
      select: { id: true, telegramId: true },
    });
  } catch (e) {
    console.error("[v4 proactive] user fetch failed:", e.message);
    return;
  }
  let sent = 0;
  for (const u of users) {
    if (!u.telegramId) continue;
    try {
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        if (!state.setup) return;
        const tz = state.timezone || "UTC";
        const hour = proactive.localHour(tz);
        if (hour !== PROACTIVE_HOUR) return;
        // Hard rate limit
        const lastAt = state.proactiveLastSentAt || 0;
        if (Date.now() - lastAt < PROACTIVE_MIN_INTERVAL_MS) return;
        const all = proactive.decideProactive(state, m.today(tz));
        const pick = proactive.pickMostImportant(all);
        if (!pick) return;
        try {
          await bot.api.sendMessage(u.telegramId, pick.text + "\n" + heroLine(state), {
            parse_mode: "Markdown",
            reply_markup: mainKeyboard(),
          });
          let next = proactive.markSent(state, [pick]);
          next.proactiveLastSentAt = Date.now();
          await db.saveState(prisma, u.id, next);
          sent++;
        } catch (e) {
          console.error("[v4 proactive send]", u.telegramId, e.message);
        }
      });
    } catch (e) {
      console.error("[v4 proactive user loop]", e.message);
    }
  }
  if (sent > 0) console.log("[v4 proactive] sent " + sent + " messages");
}

module.exports = { bot, attach, runProactive };
