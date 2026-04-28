"use strict";
// v4/bot.js — Telegram bot using v4 safe core.
// Confirm-card flow: every DO intent is shown to the user first; nothing
// applies until they tap "Yes" (or it's an auto-tier small spend with Undo).

const { Bot } = require("grammy");
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const m = require("./model");
const { applyIntent } = require("./engine");
const { compute } = require("./view");
const { processMessage } = require("./pipeline");
const db = require("./db");

const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;
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

function setPending(intent, userId) {
  const token = makeToken();
  pending.set(token, { intent, userId, expires: Date.now() + PENDING_TTL_MS });
  return token;
}

function takePending(token) {
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  return entry;
}

// ── HELPERS ─────────────────────────────────────────────
function fmtIntent(intent, sym) {
  const p = intent.params || {};
  const M = c => m.toMoney(typeof c === "number" ? c : 0, sym || "$");
  switch (intent.kind) {
    case "setup_account":
      return "Set up account · balance " + M(p.balanceCents) +
        (p.payday ? ", payday " + p.payday : "") +
        (p.payFrequency ? ", " + p.payFrequency : "");
    case "adjust_balance":
      return "Update balance to " + M(p.newBalanceCents);
    case "add_envelope":
      return "Add " + (p.kind || "item") + ": " + p.name + " · " + M(p.amountCents) +
        (p.dueDate ? " · due " + p.dueDate : "");
    case "update_envelope":
      return "Update " + (p.key || p.name);
    case "remove_envelope":
      return "Remove " + (p.key || p.name);
    case "record_spend":
      return "Spend " + M(p.amountCents) + (p.note ? " · " + p.note : "") +
        (p.envelopeKey ? " · " + p.envelopeKey : "");
    case "record_income":
      return "Income " + M(p.amountCents) + (p.note ? " · " + p.note : "");
    case "pay_bill":
      return "Mark " + (p.name || p.envelopeKey) + " paid";
    case "skip_bill":
      return "Skip " + (p.name || p.envelopeKey) + " this cycle";
    case "edit_transaction":
      return "Edit transaction" + (p.newAmountCents !== undefined ? " → " + M(p.newAmountCents) : "");
    case "delete_transaction":
      return "Delete transaction";
    case "update_settings":
      return "Update settings";
    case "reset":
      return "Reset everything";
    default:
      return intent.kind;
  }
}

function heroLine(state, sym) {
  const v = compute(state);
  if (!v.setup) return "";
  const symAct = sym || v.currencySymbol;
  const M = c => m.toMoney(c, symAct);
  if (v.state === "over") return "_You're " + M(v.deficitCents) + " over for this period._";
  if (v.state === "tight") return "_Tight: " + v.dailyPaceFormatted + "/day for " + v.daysToPayday + " days._";
  return "_" + v.dailyPaceFormatted + "/day · " + v.daysToPayday + " days to payday._";
}

function mainKeyboard() {
  const url = process.env.MINIAPP_URL;
  const kb = {
    keyboard: [[{ text: "How am I doing?" }]],
    resize_keyboard: true,
  };
  if (url && /^https:\/\//.test(url)) {
    kb.keyboard[0].push({ text: "📊 Dashboard", web_app: { url } });
  }
  return kb;
}

function confirmCard(intent, sym, token, opts) {
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

// ── PROCESS A USER TEXT MESSAGE ────────────────────────
async function processText(prisma, ctx, telegramId, text) {
  const u = await db.resolveUser(prisma, "tg_" + telegramId);
  await ctx.replyWithChatAction("typing");

  await db.withUserLock(u.id, async () => {
    const state = await db.loadState(prisma, u.id);
    const history = await db.loadHistory(prisma, u.id);

    const result = await processMessage(state, text, history);

    // Persist conversation history (talk and do both).
    await db.appendHistory(prisma, u.id, "user", text);
    if (result.message) await db.appendHistory(prisma, u.id, "assistant", result.message);

    if (result.kind === "talk") {
      await ctx.reply(result.message || "…", {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard(),
      });
      return;
    }

    // DO mode: process each decision.
    let curState = state;
    for (const d of result.decisions) {
      if (!d.verdict.ok) {
        await ctx.reply((result.message ? result.message + "\n\n" : "") + "_" + d.verdict.reason + "_", {
          parse_mode: "Markdown",
          reply_markup: mainKeyboard(),
        });
        continue;
      }
      if (d.verdict.severity === "auto") {
        // Apply now. Send a compact confirm with implicit Undo via "no" on a token.
        try {
          const r = applyIntent(curState, d.intent);
          curState = r.state;
          await db.saveState(prisma, u.id, curState);
        } catch (e) {
          await ctx.reply("Hmm — couldn't log that: " + e.message, { reply_markup: mainKeyboard() });
          continue;
        }
        const sym = curState.currencySymbol || "$";
        const text = "✓ " + fmtIntent(d.intent, sym) + "\n" + heroLine(curState, sym);
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
        continue;
      }
      // CONFIRM tier — show card with Yes/No.
      const sym = curState.currencySymbol || "$";
      const token = setPending(d.intent, u.id);
      const cardText = (result.message ? result.message + "\n\n" : "")
        + "*" + fmtIntent(d.intent, sym) + "*"
        + (d.verdict.reason && d.verdict.reason !== "Set up your account?" ? "\n_" + d.verdict.reason + "_" : "");
      await ctx.reply(cardText, {
        parse_mode: "Markdown",
        ...confirmCard(d.intent, sym, token),
      });
    }
  });
}

// ── HANDLERS ───────────────────────────────────────────
function attach(prisma) {
  if (!bot) return;

  bot.command("start", async (ctx) => {
    try {
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      const state = await db.loadState(prisma, u.id);
      if (!state.setup) {
        await ctx.reply(
          "Hey 👋 I'm SpendYes — your money friend.\n\n" +
          "Tell me your starting balance, when you next get paid, and any bills or budgets you've got. " +
          "You can hold the mic and just talk.",
          { parse_mode: "Markdown", reply_markup: mainKeyboard() }
        );
      } else {
        const sym = state.currencySymbol || "$";
        await ctx.reply("Welcome back. " + heroLine(state, sym), {
          parse_mode: "Markdown",
          reply_markup: mainKeyboard(),
        });
      }
    } catch (e) {
      console.error("[v4 /start]", e);
      await ctx.reply("Something went wrong. Try again?").catch(() => {});
    }
  });

  bot.command("app", async (ctx) => {
    const url = process.env.MINIAPP_URL;
    if (!url) return ctx.reply("Mini App is not configured.");
    await ctx.reply("Open your dashboard:", {
      reply_markup: {
        inline_keyboard: [[{ text: "📊 Open Dashboard", web_app: { url } }]],
      },
    });
  });

  bot.command("reset", async (ctx) => {
    const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
    const token = setPending({ kind: "reset", params: {} }, u.id);
    await ctx.reply("This will erase everything. Confirm?", {
      reply_markup: {
        inline_keyboard: [[
          { text: "Yes, wipe it", callback_data: "yes:" + token },
          { text: "Cancel", callback_data: "no:" + token },
        ]],
      },
    });
  });

  bot.hears(/^(How am I doing\?|how am i doing)/i, async (ctx) => {
    await processText(prisma, ctx, ctx.from.id, "How am I doing?");
  });

  bot.on("message:text", async (ctx) => {
    try {
      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return; // commands handled above
      if (text.length > 2000) return ctx.reply("That message is too long — keep it under 2000 chars.");
      await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v4 text]", e);
      await ctx.reply("Hmm, something went wrong. Try again?").catch(() => {});
    }
  });

  bot.on("message:voice", async (ctx) => {
    if (!process.env.OPENAI_API_KEY) return ctx.reply("Voice not enabled.");
    let statusMsg;
    try { statusMsg = await ctx.reply("🎙"); } catch {}
    const typing = setInterval(() => ctx.replyWithChatAction("typing").catch(() => {}), 4000);
    try {
      const file = await ctx.getFile();
      const url = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, { signal: ctrl.signal });
      const buf = Buffer.from(await resp.arrayBuffer());
      clearTimeout(t);
      const audioFile = await toFile(buf, "voice.ogg", { type: "audio/ogg" });
      const tr = await openai.audio.transcriptions.create({ file: audioFile, model: "whisper-1" }, { timeout: 15000 });
      const text = (tr.text || "").slice(0, 2000);
      if (statusMsg) ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      if (!text) return ctx.reply("Couldn't catch that — try again?");
      await processText(prisma, ctx, ctx.from.id, text);
    } catch (e) {
      console.error("[v4 voice]", e);
      if (statusMsg) ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "Couldn't process voice — try again?").catch(() => {});
      else ctx.reply("Couldn't process voice — try again?").catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      if (!data.startsWith("yes:") && !data.startsWith("no:")) return;
      const isYes = data.startsWith("yes:");
      const token = data.slice(4);
      const entry = takePending(token);
      if (!entry) {
        await ctx.editMessageText("That request expired. Try again?").catch(() => {});
        return;
      }
      const u = await db.resolveUser(prisma, "tg_" + ctx.from.id);
      if (entry.userId !== u.id) {
        await ctx.editMessageText("Hmm, that wasn't yours.").catch(() => {});
        return;
      }
      if (!isYes) {
        await ctx.editMessageText("Cancelled.").catch(() => {});
        return;
      }
      // Yes → apply
      await db.withUserLock(u.id, async () => {
        const state = await db.loadState(prisma, u.id);
        try {
          const r = applyIntent(state, entry.intent);
          await db.saveState(prisma, u.id, r.state);
          const sym = r.state.currencySymbol || "$";
          const text = "✓ Done · " + fmtIntent(entry.intent, sym) + "\n" + heroLine(r.state, sym);
          await ctx.editMessageText(text, { parse_mode: "Markdown" }).catch(() => {});
        } catch (e) {
          console.error("[v4 confirm apply]", e);
          await ctx.editMessageText("Couldn't apply that: " + e.message).catch(() => {});
        }
      });
    } catch (e) {
      console.error("[v4 callback]", e);
    }
  });
}

module.exports = { bot, attach };
