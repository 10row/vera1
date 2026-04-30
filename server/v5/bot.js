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
// In-memory map of token → { intent, userId, expires }. 30-min TTL.
const PENDING_TTL_MS = 30 * 60 * 1000;
const pending = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}, 60_000);

function makeToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// setPending accepts a single intent OR an array of intents (brain-dump).
// Stored as `intents: []` either way; consumer applies them in sequence.
function setPending(intentOrArray, userId) {
  const token = makeToken();
  const intents = Array.isArray(intentOrArray) ? intentOrArray : [intentOrArray];
  pending.set(token, { intents, userId, expires: Date.now() + PENDING_TTL_MS });
  return token;
}

function takePending(token) {
  const e = pending.get(token);
  if (!e) return null;
  pending.delete(token);
  return e;
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

function undoKeyboard(eventId, lang) {
  const label = lang === "ru" ? "Отменить" : "Undo";
  return {
    reply_markup: {
      inline_keyboard: [[{ text: label, callback_data: "undo:" + eventId }]],
    },
  };
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
    case "record_spend":
      return lang === "ru"
        ? "Расход " + M(p.amountCents) + (p.note ? " · " + E(p.note) : "")
        : "Spend " + M(p.amountCents) + (p.note ? " · " + E(p.note) : "");
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

// ── PROCESS A USER MESSAGE ────────────────────────
// `options` is harness-only — `_aiCall` injects an alternate AI backend
// for tests. Production callers don't pass it.
async function processText(prisma, ctx, telegramId, text, options) {
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  await ctx.replyWithChatAction("typing").catch(() => {});

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
      const token = setPending(logIntent, u.id);
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
      const token = setPending(result.intent, u.id);
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
      const token = setPending(intents, u.id);
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
    await safeReply(ctx, heroLineWithInsight(state, lang), { parse_mode: "Markdown" });
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
        await safeReply(ctx, head + (what ? ": " + what : "") + "\n" + heroLineWithInsight(r.state, lang), { parse_mode: "Markdown" });
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
    const token = setPending({ kind: "reset", params: {} }, u.id);
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
        await safeReply(ctx, (lang === "ru" ? "Отменено.\n" : "Undone.\n") + heroLineWithInsight(r.state, lang), { parse_mode: "Markdown" });
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
  const entry = takePending(token);
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  let state = await db.loadState(prisma, u.id);
  const lang = state.language === "ru" ? "ru" : "en";

  // Critical: every safeEdit on a confirm card MUST clear the inline
  // keyboard. Otherwise stale buttons remain tappable, the user re-taps,
  // hits the expired path, and the bot looks broken. Telegram's API
  // requires reply_markup to be passed explicitly to clear.
  const clearButtons = { reply_markup: { inline_keyboard: [] } };

  if (!entry || entry.userId !== u.id) {
    await safeEdit(ctx, lang === "ru" ? "Кнопка устарела." : "That confirm has expired.", clearButtons);
    return;
  }
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

      // Edit the original card to a summary of what landed.
      const summaryLines = applied.map(i => "✓ " + describeIntent(i, state));
      const failedLines = failed.map(f => (lang === "ru" ? "✗ " : "✗ ") + describeIntent(f.intent, state) + " — _" + m.escapeMd(f.reason) + "_");
      const summary = summaryLines.concat(failedLines).join("\n");
      await safeEdit(ctx, summary || (lang === "ru" ? "Ничего не применили." : "Nothing applied."), Object.assign({ parse_mode: "Markdown" }, clearButtons));

      // Reset short-circuit: same flow as before, only when reset was the SOLE applied intent.
      if (applied.length === 1 && applied[0].kind === "reset") {
        await safeReply(ctx, lang === "ru" ? "Сброшено. Сколько примерно сейчас на счёте?" : "Reset done. What's roughly in your account?");
        return;
      }
      if (applied.length === 0) return;

      // Hero + undo for the most-recent applied event.
      const eventId = state.events && state.events.length
        ? state.events[state.events.length - 1].id
        : null;
      const opts = { parse_mode: "Markdown" };
      const lastApplied = applied[applied.length - 1];
      if (eventId && lastApplied.kind !== "undo_last") {
        opts.reply_markup = undoKeyboard(eventId, lang).reply_markup;
      }
      await safeReply(ctx, heroLineWithInsight(state, lang), opts);
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

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || (text.startsWith("/") && text.length < 30)) return;
    try {
      await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v5 text]", e);
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
