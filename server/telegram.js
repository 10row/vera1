"use strict";
// telegram.js — SpendYes v2 Telegram Bot (handlers + setup)

const Anthropic = require("@anthropic-ai/sdk").default;
const OpenAI = require("openai");
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v2 = require("./vera-v2");
const { callSpendYes, callReview } = require("./tg-ai");
const {
  t, detectLang, fmt, daysUntil,
  formatPicture, formatActionReply,
  formatMorningBriefing, formatBillAlert, formatSpendFeed,
} = require("./tg-format");

// Safe import of API logger
let logApiCall = async () => {};
try {
  const admin = require("./admin");
  if (admin && typeof admin.logApiCall === "function") logApiCall = admin.logApiCall;
} catch (e) { console.warn("Admin logging unavailable:", e.message); }

const anthropic = new Anthropic();
const openai = new OpenAI();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;
const pendingReceipts = new Map();

// ── KEYBOARDS ──────────────────────────────────
function mainKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "spent"), "quick_spent")
    .text(t(lang, "received"), "quick_received")
    .row()
    .text(t(lang, "review"), "review")
    .row()
    .text(t(lang, "picture"), "show_picture")
    .row()
    .text(t(lang, "feedWeek"), "feed_week")
    .text(t(lang, "feedMonth"), "feed_month");
}

function billActionKeyboard(lang, billName) {
  return new InlineKeyboard()
    .text(t(lang, "paidBtn") + billName, "paid:" + billName)
    .text(t(lang, "skipBtn"), "skip:" + billName);
}

function receiptConfirmKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "confirmReceipt"), "receipt_confirm")
    .text(t(lang, "editReceipt"), "receipt_edit")
    .row()
    .text(t(lang, "cancelReceipt"), "receipt_cancel");
}

// ── HELPERS ────────────────────────────────────
async function getUserAndState(telegramId) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
  if (!user) user = await prisma.user.create({ data: { telegramId: String(telegramId) } });
  const state = await db.loadState(prisma, user.id);
  return { user, state };
}

async function ensureLanguage(ctx, user, state) {
  const detected = detectLang(ctx);
  if (state.language !== detected && !state.setup) {
    state.language = detected;
    await prisma.user.update({ where: { id: user.id }, data: { language: detected } });
  }
  return state.language || "en";
}

function maybeNudge(txCount, lang) {
  if (txCount === 3) return t(lang, "nudge3");
  if (txCount === 5) return t(lang, "nudge5");
  return "";
}

// ── PROCESS MESSAGE ────────────────────────────
async function processMessage(ctx, telegramId, text) {
  const { user } = await getUserAndState(telegramId);
  await ctx.replyWithChatAction("typing");
  await db.withUserLock(user.id, async () => {
    const state = await db.loadState(prisma, user.id);
    const lang = await ensureLanguage(ctx, user, state);
    const { text: rawText, parsed } = await callSpendYes(state, text);
    state.conversationHistory.push({ role: "user", content: text });
    state.conversationHistory.push({ role: "assistant", content: rawText });
    if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);
    let newState = state;
    const hasReset = (parsed.actions || []).some(a => a.type === "reset");
    if (hasReset) {
      await prisma.$transaction([
        prisma.transaction.deleteMany({ where: { userId: user.id } }),
        prisma.drain.deleteMany({ where: { userId: user.id } }),
        prisma.pool.deleteMany({ where: { userId: user.id } }),
        prisma.plannedPurchase.deleteMany({ where: { userId: user.id } }),
        prisma.monthlySummary.deleteMany({ where: { userId: user.id } }),
        prisma.cycleSummary.deleteMany({ where: { userId: user.id } }),
        prisma.message.deleteMany({ where: { userId: user.id } }),
        prisma.user.update({
          where: { id: user.id },
          data: {
            setup: false, balanceCents: 0, incomeCents: 0,
            savingsCents: 0, savingRateBps: 0,
            payday: null, cycleStart: null,
            recurring: true, localRate: 100, language: lang,
          },
        }),
      ]);
      newState = v2.createFreshState();
      newState.language = lang;
    } else {
      for (const action of (parsed.actions || [])) {
        newState = v2.applyAction(newState, action);
      }
      await db.saveState(prisma, user.id, newState);
    }
    const pic = v2.computePicture(newState);
    const hasTx = parsed.actions?.some(a =>
      a.type === "transaction" || a.type === "income" ||
      a.type === "confirm_payment" || a.type === "confirm_planned"
    );
    const justSetUp = !state.setup && newState.setup;
    const nudge = hasTx ? maybeNudge(newState.transactions.length, lang) : "";
    if (newState.setup && (justSetUp || hasTx)) {
      const msg = (parsed.message || "Got it.") + "\n\n" + formatActionReply(pic, lang) + nudge;
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
    } else {
      await ctx.reply(parsed.message || "Got it.", {
        parse_mode: "Markdown",
        reply_markup: newState.setup ? mainKeyboard(lang) : undefined,
      });
    }
  });
}

// ── TEXT MESSAGE HANDLER ───────────────────────
if (bot) bot.on("message:text", async (ctx) => {
  try {
    await processMessage(ctx, ctx.from.id, ctx.message.text);
  } catch (err) {
    console.error("Message handler error:", err);
    await ctx.reply(t(detectLang(ctx), "error"));
  }
});

// ── VOICE HANDLER ──────────────────────────────
if (bot) bot.on("message:voice", async (ctx) => {
  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply("Voice isn't enabled. Type it instead.");
    return;
  }
  try {
    await ctx.replyWithChatAction("typing");
    const file = await ctx.getFile();
    const fileUrl = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], "voice.ogg", { type: "audio/ogg" }),
      model: "whisper-1",
    });
    if (!transcription.text) { await ctx.reply("Couldn't catch that."); return; }
    await processMessage(ctx, ctx.from.id, transcription.text);
  } catch (err) {
    console.error("Voice handler error:", err);
    await ctx.reply("Couldn't process that voice message.");
  }
});

// ── PHOTO / RECEIPT HANDLER ────────────────────
if (bot) bot.on("message:photo", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = state.language || detectLang(ctx);
    if (!state.setup) { await ctx.reply(t(lang, "setupFirst")); return; }
    await ctx.replyWithChatAction("typing");
    await ctx.reply(t(lang, "receiptReading"), { parse_mode: "Markdown" });
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const fileUrl = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const imgRes = await fetch(fileUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const b64 = Buffer.from(imgBuffer).toString("base64");
    const receiptResp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: 'Extract the total amount and a short description from this receipt. Reply with JSON: {"description": "...", "amountUSD": number}. If there\'s a foreign currency amount, include "localAmount" and "currency" fields too.' },
        ],
      }],
    });
    const rU = receiptResp.usage || {};
    logApiCall(null, "claude-haiku-4-5-20251001", rU.input_tokens || 0, rU.output_tokens || 0, "receipt").catch(() => {});
    const receiptText = receiptResp.content?.[0]?.text ?? "";
    let receipt;
    try { receipt = JSON.parse(receiptText); } catch {
      const jm = receiptText.match(/\{[\s\S]*\}/);
      if (jm) receipt = JSON.parse(jm[0]);
      else { await ctx.reply(t(lang, "receiptFailed")); return; }
    }
    if (!receipt.amountUSD || !receipt.description) {
      await ctx.reply(t(lang, "receiptFailed"));
      return;
    }
    pendingReceipts.set(String(ctx.from.id), {
      description: receipt.description,
      amountUSD: receipt.amountUSD,
      userId: user.id,
    });
    const msg = t(lang, "receiptRead")
      .replace("DESC", receipt.description)
      .replace("AMT", fmt(v2.toCents(receipt.amountUSD)));
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: receiptConfirmKeyboard(lang) });
  } catch (err) {
    console.error("Photo handler error:", err);
    await ctx.reply(t(detectLang(ctx), "receiptFailed"));
  }
});

// ── /start COMMAND ─────────────────────────────
if (bot) bot.command("start", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = await ensureLanguage(ctx, user, state);
    if (state.setup) {
      const pic = v2.computePicture(state);
      const txCount = state.transactions.length;
      let greeting;
      if (txCount === 0) {
        greeting = lang === "ru"
          ? "С возвращением! Просто пиши что тратишь, или сфоткай чек \u{1F4F8}"
          : "Welcome back! Just tell me what you spend, or snap a receipt \u{1F4F8}";
      } else if (pic.trulyFreeCents < 0) {
        greeting = lang === "ru"
          ? "Привет. Сейчас туго — счета превышают баланс. Нажми *Как дела?*"
          : "Hey. Things are tight right now. Tap *How'm I doing?* for the full picture.";
      } else if (pic.daysLeft <= 3) {
        greeting = (lang === "ru"
          ? "Почти зарплата! Сегодня свободно "
          : "Almost payday! Free today: ") + fmt(pic.freeRemainingTodayCents);
      } else {
        greeting = fmt(pic.freeRemainingTodayCents) + (lang === "ru"
          ? " свободно сегодня, " + fmt(pic.dailyFreePaceCents) + "/день, " + pic.daysLeft + " дн. до зарплаты."
          : " free today, " + fmt(pic.dailyFreePaceCents) + "/day, " + pic.daysLeft + " days to payday.");
      }
      await ctx.reply(greeting + "\n\n" + formatPicture(pic, lang), {
        parse_mode: "Markdown", reply_markup: mainKeyboard(lang),
      });
    } else {
      await ctx.reply(t(lang, "welcome"), { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Start error:", err);
  }
});

// ── /reset COMMAND ─────────────────────────────
if (bot) bot.command("reset", async (ctx) => {
  try {
    const telegramId = String(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      await ctx.reply(t(detectLang(ctx), "resetConfirm"));
      return;
    }
    const lang = (await db.loadState(prisma, user.id)).language || detectLang(ctx);
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: user.id } }),
      prisma.drain.deleteMany({ where: { userId: user.id } }),
      prisma.pool.deleteMany({ where: { userId: user.id } }),
      prisma.plannedPurchase.deleteMany({ where: { userId: user.id } }),
      prisma.monthlySummary.deleteMany({ where: { userId: user.id } }),
      prisma.cycleSummary.deleteMany({ where: { userId: user.id } }),
      prisma.message.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          setup: false, balanceCents: 0, incomeCents: 0,
          savingsCents: 0, savingRateBps: 0,
          payday: null, cycleStart: null,
          recurring: true, localRate: 100, language: lang,
        },
      }),
    ]);
    await ctx.reply(t(lang, "resetConfirm"));
  } catch (err) {
    console.error("Reset error:", err);
    await ctx.reply(t(detectLang(ctx), "resetFail"));
  }
});

// ── CALLBACK QUERIES ───────────────────────────
if (bot) bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = state.language || detectLang(ctx);

    if (data === "quick_spent") {
      await ctx.reply(t(lang, "spentPrompt"), { parse_mode: "Markdown" });
      return;
    }
    if (data === "quick_received") {
      await ctx.reply(t(lang, "receivedPrompt"), { parse_mode: "Markdown" });
      return;
    }
    if (data === "review") {
      if (!state.setup) { await ctx.reply(t(lang, "setupFirstReview")); return; }
      await ctx.replyWithChatAction("typing");
      const reviewText = await callReview(state);
      state.conversationHistory.push({ role: "user", content: lang === "ru" ? "Как дела?" : "How'm I doing?" });
      state.conversationHistory.push({ role: "assistant", content: reviewText });
      if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);
      await db.saveState(prisma, user.id, state);
      await ctx.reply(reviewText, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data === "feed_week" || data === "feed_month") {
      if (!state.setup) { await ctx.reply(t(lang, "setupFirst")); return; }
      const pic = v2.computePicture(state);
      const period = data === "feed_week" ? "week" : "month";
      await ctx.reply(formatSpendFeed(pic, state, period, lang), {
        parse_mode: "Markdown", reply_markup: mainKeyboard(lang),
      });
      return;
    }
    if (data === "show_picture") {
      const pic = v2.computePicture(state);
      await ctx.reply(formatPicture(pic, lang), {
        parse_mode: "Markdown", reply_markup: mainKeyboard(lang),
      });
      return;
    }

    // Receipt confirmation
    if (data === "receipt_confirm") {
      const rc = pendingReceipts.get(String(ctx.from.id));
      if (!rc) { await ctx.reply("No pending receipt."); return; }
      pendingReceipts.delete(String(ctx.from.id));
      await db.withUserLock(user.id, async () => {
        const fs = await db.loadState(prisma, user.id);
        let ns = v2.applyAction(fs, { type: "transaction", data: { description: rc.description, amountUSD: rc.amountUSD } });
        await db.saveState(prisma, user.id, ns);
        const p = v2.computePicture(ns);
        const msg = t(lang, "receiptLogged")
          .replace("DESC", rc.description)
          .replace("AMT", fmt(v2.toCents(rc.amountUSD)));
        await ctx.editMessageText(
          msg + "\n\n" + formatActionReply(p, lang) + maybeNudge(ns.transactions.length, lang),
          { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) }
        );
      });
      return;
    }
    if (data === "receipt_edit" || data === "receipt_cancel") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(
        t(lang, data === "receipt_edit" ? "receiptEdit" : "receiptCancelled"),
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Bill paid/skip
    if (data.startsWith("paid:") || data.startsWith("skip:")) {
      const isPaid = data.startsWith("paid:");
      const bn = data.slice(isPaid ? 5 : 5);
      await db.withUserLock(user.id, async () => {
        const fs = await db.loadState(prisma, user.id);
        const ns = v2.applyAction(fs, {
          type: isPaid ? "confirm_payment" : "skip_payment",
          data: { name: bn },
        });
        await db.saveState(prisma, user.id, ns);
        const np = v2.computePicture(ns);
        await ctx.editMessageText(
          t(lang, isPaid ? "paidConfirm" : "skippedConfirm").replace("NAME", bn)
            + "\n\n" + formatActionReply(np, lang),
          { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) }
        );
      });
      return;
    }
  } catch (err) {
    console.error("Callback handler error:", err);
  }
});

// ── PROACTIVE FUNCTIONS ────────────────────────
async function sendMorningBriefing(tid) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(tid);
    if (!state.setup) return;
    const lang = state.language || "en";
    const pic = v2.computePicture(state);
    await bot.api.sendMessage(tid, formatMorningBriefing(pic, lang), {
      parse_mode: "Markdown", reply_markup: mainKeyboard(lang),
    });
  } catch (e) { console.error("Briefing err:", e); }
}

async function sendBillAlert(tid, bn) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(tid);
    if (!state.setup) return;
    const lang = state.language || "en";
    const dr = Object.values(state.drains).find(
      d => d.name.toLowerCase() === bn.toLowerCase() && d.active
    );
    if (!dr) return;
    const pic = v2.computePicture(state);
    await bot.api.sendMessage(tid, formatBillAlert(dr, pic, lang), {
      parse_mode: "Markdown",
    });
  } catch (e) { console.error("Bill alert err:", e); }
}

async function runDailyBriefings() {
  try {
    const us = await prisma.user.findMany({
      where: { setup: true, telegramId: { not: null } },
      select: { telegramId: true },
    });
    for (const u of us) {
      if (u.telegramId) await sendMorningBriefing(u.telegramId);
    }
    console.log("Briefings sent:", us.length);
  } catch (e) { console.error("Briefings err:", e); }
}

async function runBillAlerts() {
  try {
    const us = await prisma.user.findMany({
      where: { setup: true, telegramId: { not: null } },
      select: { id: true, telegramId: true },
    });
    for (const u of us) {
      const st = await db.loadState(prisma, u.id);
      const pic = v2.computePicture(st);
      for (const b of (pic.upcomingBills || [])) {
        if (b.days <= 1) await sendBillAlert(u.telegramId, b.name);
      }
    }
  } catch (e) { console.error("Bill alerts err:", e); }
}

module.exports = { bot, sendMorningBriefing, sendBillAlert, runDailyBriefings, runBillAlerts };
