"use strict";
// v5/bot.js — Telegram bot. Confirm-then-apply for every action.
// Onboarding is deterministic (no AI). Post-setup is single-intent AI.

const { Bot } = require("grammy");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const m = require("./model");
const { applyIntent } = require("./engine");
const { compute, heroLine, simulateSpend } = require("./view");
const { processMessage } = require("./pipeline");
const db = require("./db");

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

function setPending(intent, userId) {
  const token = makeToken();
  pending.set(token, { intent, userId, expires: Date.now() + PENDING_TTL_MS });
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
async function processText(prisma, ctx, telegramId, text) {
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  await ctx.replyWithChatAction("typing").catch(() => {});

  await db.withUserLock(u.id, async () => {
    let state = await db.loadState(prisma, u.id);
    const lang = state.language === "ru" ? "ru" : "en";
    const history = await db.loadHistory(prisma, u.id);

    // Persist user message into history.
    await db.appendHistory(prisma, u.id, "user", text);

    const result = await processMessage(state, text, history);

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
        reply += "\n\n" + heroLine(state, lang);
      }
      await db.appendHistory(prisma, u.id, "assistant", reply);
      await safeReply(ctx, reply, { parse_mode: "Markdown" });
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
        if (sim.projected.status === "over") {
          lines.push(lang === "ru"
            ? "🔴 Это даст " + M(sim.projected.deficitCents) + " дефицита."
            : "🔴 That'd put you " + M(sim.projected.deficitCents) + " over.");
        } else if (sim.projected.status === "tight") {
          lines.push(lang === "ru"
            ? "🟡 Останется " + sim.projected.dailyPaceFormatted + "/день на " + sim.projected.daysToPayday + " дн."
            : "🟡 You'd drop to " + sim.projected.dailyPaceFormatted + "/day for " + sim.projected.daysToPayday + " days.");
        } else {
          lines.push(lang === "ru"
            ? "🟢 Останется " + sim.projected.dailyPaceFormatted + "/день."
            : "🟢 You'd still have " + sim.projected.dailyPaceFormatted + "/day.");
        }
      }
      // Offer "log it now" button.
      const logIntent = {
        kind: "record_spend",
        params: { amountCents: result.amountCents, note: "" },
      };
      const token = setPending(logIntent, u.id);
      const yesLabel = lang === "ru" ? "Записать" : "Log it";
      const noLabel = lang === "ru" ? "Нет" : "No";
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
  });
}

// ── HANDLERS ──────────────────────────────────────
function attach(prisma) {
  if (!bot) return;

  bot.command("start", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";
      if (!state.setup) {
        // Trigger onboarding by sending the same routing as a normal message.
        await processText(prisma, ctx, ctx.from.id, "/start");
      } else {
        await safeReply(ctx, heroLine(state, lang), { parse_mode: "Markdown" });
      }
    } catch (e) {
      console.error("[v5 /start]", e);
    }
  });

  bot.command("today", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";
      if (!state.setup) {
        await safeReply(ctx, lang === "ru" ? "Сначала настроим — какой баланс?" : "Set up first — what's your balance?");
        return;
      }
      await safeReply(ctx, heroLine(state, lang), { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[v5 /today]", e);
    }
  });

  bot.command("undo", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
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
    } catch (e) {
      console.error("[v5 /undo]", e);
    }
  });

  bot.command("reset", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
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
    } catch (e) {
      console.error("[v5 /reset]", e);
    }
  });

  bot.command("app", async (ctx) => {
    const url = process.env.MINIAPP_URL;
    if (!url) {
      await safeReply(ctx, "Mini app not configured.");
      return;
    }
    await safeReply(ctx, "Open the mini app:", {
      reply_markup: { inline_keyboard: [[{ text: "Open", web_app: { url } }]] },
    });
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || (text.startsWith("/") && text.length < 30)) return; // commands handled above
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
      // Undo button (after a confirm-applied action).
      if (data.startsWith("undo:")) {
        const eventId = data.slice(5);
        const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
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
      const token = data.slice(4);
      const entry = takePending(token);
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      let state = await db.loadState(prisma, u.id);
      const lang = state.language === "ru" ? "ru" : "en";

      if (!entry || entry.userId !== u.id) {
        await safeEdit(ctx, lang === "ru" ? "Кнопка устарела." : "That confirm has expired.");
        return;
      }

      if (!isYes) {
        await safeEdit(ctx, lang === "ru" ? "Отменено." : "Cancelled.");
        return;
      }

      // Yes → apply the intent.
      await db.withUserLock(u.id, async () => {
        state = await db.loadState(prisma, u.id);
        try {
          const r = applyIntent(state, entry.intent);
          await db.saveState(prisma, u.id, r.state);

          // Edit the original card to show "✓ done".
          const summary = "✓ " + describeIntent(entry.intent, r.state);
          await safeEdit(ctx, summary, { parse_mode: "Markdown" });

          // If reset: special welcome.
          if (entry.intent.kind === "reset") {
            await safeReply(ctx, lang === "ru"
              ? "Сброшено. Сколько примерно сейчас на счёте?"
              : "Reset done. What's roughly in your account?");
            return;
          }

          // Send hero + undo button.
          const eventId = r.state.events && r.state.events.length
            ? r.state.events[r.state.events.length - 1].id
            : null;
          const opts = { parse_mode: "Markdown" };
          if (eventId && entry.intent.kind !== "undo_last") {
            opts.reply_markup = undoKeyboard(eventId, lang).reply_markup;
          }
          await safeReply(ctx, heroLine(r.state, lang), opts);
        } catch (e) {
          console.error("[v5 confirm apply]", e);
          await safeEdit(ctx, "_" + m.escapeMd(e.message) + "_", { parse_mode: "Markdown" });
        }
      });
    } catch (e) {
      console.error("[v5 callback]", e);
    }
  });
}

module.exports = { bot, attach, processText };
