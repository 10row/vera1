"use strict";
const Anthropic = require("@anthropic-ai/sdk").default;
const OpenAI = require("openai");
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v2 = require("./vera-v2");
const { callSpendYes, callReview } = require("./tg-ai");
const { t, detectLang, fmt, formatPicture, formatActionReply, formatMorningBriefing, formatBillAlert, formatSpendFeed } = require("./tg-format");

let logApiCall = async () => {};
try { const a = require("./admin"); if (a && typeof a.logApiCall === "function") logApiCall = a.logApiCall; }
catch (e) { console.warn("Admin logging unavailable:", e.message); }

const anthropic = new Anthropic();
const openai = new OpenAI();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;
const pendingReceipts = new Map();
setInterval(() => { const c = Date.now() - 1800000; for (const [k, v] of pendingReceipts) { if (v.ts < c) pendingReceipts.delete(k); } }, 600000);

// Safe reply — falls back to plain text if Markdown fails
async function safeReply(ctx, text, opts = {}) {
  try { return await ctx.reply(text, opts); }
  catch (e) { if (e.message?.includes("can't parse")) { const o = { ...opts }; delete o.parse_mode; return await ctx.reply(text, o); } throw e; }
}
async function safeEdit(ctx, text, opts = {}) {
  try { return await ctx.editMessageText(text, opts); }
  catch (e) { if (e.message?.includes("can't parse")) { const o = { ...opts }; delete o.parse_mode; return await ctx.editMessageText(text, o); } throw e; }
}

function mainKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "spent"), "quick_spent").text(t(lang, "received"), "quick_received").row()
    .text(t(lang, "review"), "review").row()
    .text(t(lang, "picture"), "show_picture").row()
    .text(t(lang, "feedWeek"), "feed_week").text(t(lang, "feedMonth"), "feed_month");
}
function billActionKeyboard(lang, billName) {
  const bn = billName.slice(0, 50);
  return new InlineKeyboard().text(t(lang, "paidBtn") + bn, "paid:" + bn).text(t(lang, "skipBtn"), "skip:" + bn);
}
function receiptConfirmKeyboard(lang) {
  return new InlineKeyboard().text(t(lang, "confirmReceipt"), "receipt_confirm").text(t(lang, "editReceipt"), "receipt_edit").row().text(t(lang, "cancelReceipt"), "receipt_cancel");
}

async function getUserAndState(telegramId) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
  if (!user) user = await prisma.user.create({ data: { telegramId: String(telegramId) } });
  return { user, state: await db.loadState(prisma, user.id) };
}
async function ensureLanguage(ctx, user, state) {
  const d = detectLang(ctx);
  if (state.language !== d && !state.setup) { state.language = d; await prisma.user.update({ where: { id: user.id }, data: { language: d } }); }
  return state.language || "en";
}
function maybeNudge(n, lang) { return n === 3 ? t(lang, "nudge3") : n === 5 ? t(lang, "nudge5") : ""; }

async function processMessage(ctx, telegramId, text) {
  const { user } = await getUserAndState(telegramId);
  await ctx.replyWithChatAction("typing");
  await db.withUserLock(user.id, async () => {
    const state = await db.loadState(prisma, user.id);
    const lang = await ensureLanguage(ctx, user, state);
    const { text: raw, parsed } = await callSpendYes(state, text, user.id);
    state.conversationHistory.push({ role: "user", content: text });
    state.conversationHistory.push({ role: "assistant", content: raw });
    if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);
    let ns = state;
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
        prisma.user.update({ where: { id: user.id }, data: { setup: false, balanceCents: 0, incomeCents: 0, savingsCents: 0, savingRateBps: 0, payday: null, cycleStart: null, recurring: true, localRate: 100, language: lang } }),
      ]);
      ns = v2.createFreshState(); ns.language = lang;
    } else {
      for (const a of (parsed.actions || [])) ns = v2.applyAction(ns, a);
      await db.saveState(prisma, user.id, ns);
    }
    const pic = v2.computePicture(ns);
    const hasTx = parsed.actions?.some(a => a.type === "transaction" || a.type === "income" || a.type === "confirm_payment" || a.type === "confirm_planned");
    const justSetUp = !state.setup && ns.setup;
    const nudge = hasTx ? maybeNudge(ns.transactions.length, lang) : "";
    if (ns.setup && (justSetUp || hasTx)) {
      await safeReply(ctx, (parsed.message || "Got it.") + "\n\n" + formatActionReply(pic, lang) + nudge, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
    } else {
      await safeReply(ctx, parsed.message || "Got it.", { parse_mode: "Markdown", reply_markup: ns.setup ? mainKeyboard(lang) : undefined });
    }
  });
}

if (bot) bot.on("message:text", async (ctx) => {
  try { await processMessage(ctx, ctx.from.id, ctx.message.text); }
  catch (err) { console.error("Msg err:", err); await ctx.reply(t(detectLang(ctx), "error")).catch(() => {}); }
});

if (bot) bot.on("message:voice", async (ctx) => {
  if (!process.env.OPENAI_API_KEY) { await ctx.reply("Voice not enabled."); return; }
  try {
    await ctx.replyWithChatAction("typing");
    const file = await ctx.getFile();
    const url = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const buf = await (await fetch(url)).arrayBuffer();
    const tr = await openai.audio.transcriptions.create({ file: new File([buf], "voice.ogg", { type: "audio/ogg" }), model: "whisper-1" });
    if (!tr.text) { await ctx.reply("Couldn't catch that."); return; }
    await processMessage(ctx, ctx.from.id, tr.text);
  } catch (err) { console.error("Voice err:", err); await ctx.reply("Couldn't process voice.").catch(() => {}); }
});

if (bot) bot.on("message:photo", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = state.language || detectLang(ctx);
    if (!state.setup) { await ctx.reply(t(lang, "setupFirst")); return; }
    await ctx.replyWithChatAction("typing");
    await ctx.reply(t(lang, "receiptReading"), { parse_mode: "Markdown" });
    const photos = ctx.message.photo, largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const url = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const b64 = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64");
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 512,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: 'Extract total amount and short description from this receipt. Reply JSON: {"description":"...","amountUSD":number}. Foreign currency? Add "localAmount" and "currency".' }
      ]}],
    });
    const rU = resp.usage || {};
    logApiCall(user.id, "claude-haiku-4-5-20251001", rU.input_tokens || 0, rU.output_tokens || 0, "receipt").catch(() => {});
    const rt = resp.content?.[0]?.text ?? "";
    let rc;
    try { rc = JSON.parse(rt); } catch { const m = rt.match(/\{[\s\S]*\}/); if (m) rc = JSON.parse(m[0]); else { await ctx.reply(t(lang, "receiptFailed")); return; } }
    if (!rc.amountUSD || !rc.description) { await ctx.reply(t(lang, "receiptFailed")); return; }
    pendingReceipts.set(String(ctx.from.id), { description: rc.description, amountUSD: rc.amountUSD, userId: user.id, ts: Date.now() });
    await ctx.reply(t(lang, "receiptRead").replace("DESC", rc.description).replace("AMT", fmt(v2.toCents(rc.amountUSD))), { parse_mode: "Markdown", reply_markup: receiptConfirmKeyboard(lang) });
  } catch (err) { console.error("Photo err:", err); await ctx.reply(t(detectLang(ctx), "receiptFailed")).catch(() => {}); }
});

if (bot) bot.command("start", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = await ensureLanguage(ctx, user, state);
    if (state.setup) {
      const pic = v2.computePicture(state), n = state.transactions.length;
      let g;
      if (n === 0) g = lang === "ru" ? "С возвращением! Пиши что тратишь или сфоткай чек \u{1F4F8}" : "Welcome back! Tell me what you spend, or snap a receipt \u{1F4F8}";
      else if (pic.trulyFreeCents < 0) g = lang === "ru" ? "Привет. Сейчас туго. Нажми *Как дела?*" : "Hey. Things are tight. Tap *How'm I doing?*";
      else if (pic.daysLeft <= 3) g = (lang === "ru" ? "Почти зарплата! Свободно " : "Almost payday! Free today: ") + fmt(pic.freeRemainingTodayCents);
      else g = fmt(pic.freeRemainingTodayCents) + (lang === "ru" ? " свободно, " + fmt(pic.dailyFreePaceCents) + "/день, " + pic.daysLeft + " дн." : " free today, " + fmt(pic.dailyFreePaceCents) + "/day, " + pic.daysLeft + " days.");
      await safeReply(ctx, g + "\n\n" + formatPicture(pic, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
    } else { await ctx.reply(t(lang, "welcome"), { parse_mode: "Markdown" }); }
  } catch (err) { console.error("Start err:", err); }
});

if (bot) bot.command("reset", async (ctx) => {
  try {
    const tid = String(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId: tid } });
    if (!user) { await ctx.reply(t(detectLang(ctx), "resetConfirm")); return; }
    const lang = (await db.loadState(prisma, user.id)).language || detectLang(ctx);
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: user.id } }),
      prisma.drain.deleteMany({ where: { userId: user.id } }),
      prisma.pool.deleteMany({ where: { userId: user.id } }),
      prisma.plannedPurchase.deleteMany({ where: { userId: user.id } }),
      prisma.monthlySummary.deleteMany({ where: { userId: user.id } }),
      prisma.cycleSummary.deleteMany({ where: { userId: user.id } }),
      prisma.message.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({ where: { id: user.id }, data: { setup: false, balanceCents: 0, incomeCents: 0, savingsCents: 0, savingRateBps: 0, payday: null, cycleStart: null, recurring: true, localRate: 100, language: lang } }),
    ]);
    await ctx.reply(t(lang, "resetConfirm"));
  } catch (err) { console.error("Reset err:", err); await ctx.reply(t(detectLang(ctx), "resetFail")).catch(() => {}); }
});

if (bot) bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = state.language || detectLang(ctx);
    if (data === "quick_spent") { await ctx.reply(t(lang, "spentPrompt"), { parse_mode: "Markdown" }); return; }
    if (data === "quick_received") { await ctx.reply(t(lang, "receivedPrompt"), { parse_mode: "Markdown" }); return; }
    if (data === "review") {
      if (!state.setup) { await ctx.reply(t(lang, "setupFirstReview")); return; }
      await ctx.replyWithChatAction("typing");
      const rv = await callReview(state, user.id);
      state.conversationHistory.push({ role: "user", content: lang === "ru" ? "Как дела?" : "How'm I doing?" });
      state.conversationHistory.push({ role: "assistant", content: rv });
      if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);
      await db.saveState(prisma, user.id, state);
      await safeReply(ctx, rv, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data === "feed_week" || data === "feed_month") {
      if (!state.setup) { await ctx.reply(t(lang, "setupFirst")); return; }
      const pic = v2.computePicture(state);
      await safeReply(ctx, formatSpendFeed(pic, state, data === "feed_week" ? "week" : "month", lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data === "show_picture") {
      await safeReply(ctx, formatPicture(v2.computePicture(state), lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data === "receipt_confirm") {
      const rc = pendingReceipts.get(String(ctx.from.id));
      if (!rc) { await ctx.reply("No pending receipt."); return; }
      pendingReceipts.delete(String(ctx.from.id));
      await db.withUserLock(user.id, async () => {
        const fs = await db.loadState(prisma, user.id);
        let ns = v2.applyAction(fs, { type: "transaction", data: { description: rc.description, amountUSD: rc.amountUSD } });
        await db.saveState(prisma, user.id, ns); const p = v2.computePicture(ns);
        const msg = t(lang, "receiptLogged").replace("DESC", rc.description).replace("AMT", fmt(v2.toCents(rc.amountUSD)));
        await safeEdit(ctx, msg + "\n\n" + formatActionReply(p, lang) + maybeNudge(ns.transactions.length, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      }); return;
    }
    if (data === "receipt_edit" || data === "receipt_cancel") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(t(lang, data === "receipt_edit" ? "receiptEdit" : "receiptCancelled"), { parse_mode: "Markdown" });
      return;
    }
    if (data.startsWith("paid:") || data.startsWith("skip:")) {
      const isPaid = data.startsWith("paid:"), bn = data.slice(5);
      await db.withUserLock(user.id, async () => {
        const fs = await db.loadState(prisma, user.id);
        const ns = v2.applyAction(fs, { type: isPaid ? "confirm_payment" : "skip_payment", data: { name: bn } });
        await db.saveState(prisma, user.id, ns); const np = v2.computePicture(ns);
        await safeEdit(ctx, t(lang, isPaid ? "paidConfirm" : "skippedConfirm").replace("NAME", bn) + "\n\n" + formatActionReply(np, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      }); return;
    }
  } catch (err) { console.error("CB err:", err); }
});

async function sendMorningBriefing(tid) {
  if (!bot) return;
  try { const { state } = await getUserAndState(tid); if (!state.setup) return;
    const l = state.language || "en", p = v2.computePicture(state);
    await bot.api.sendMessage(tid, formatMorningBriefing(p, l), { parse_mode: "Markdown", reply_markup: mainKeyboard(l) });
  } catch (e) { console.error("Briefing err:", e); }
}
async function sendBillAlert(tid, bn) {
  if (!bot) return;
  try { const { state } = await getUserAndState(tid); if (!state.setup) return;
    const l = state.language || "en", dr = Object.values(state.drains).find(d => d.name.toLowerCase() === bn.toLowerCase() && d.active);
    if (!dr) return; const p = v2.computePicture(state);
    await bot.api.sendMessage(tid, formatBillAlert(dr, p, l), { parse_mode: "Markdown" });
  } catch (e) { console.error("Bill alert err:", e); }
}
async function runDailyBriefings() {
  try { const us = await prisma.user.findMany({ where: { setup: true, telegramId: { not: null } }, select: { telegramId: true } });
    for (const u of us) if (u.telegramId) await sendMorningBriefing(u.telegramId);
    console.log("Briefings:", us.length);
  } catch (e) { console.error("Briefings err:", e); }
}
async function runBillAlerts() {
  try {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const due = await prisma.drain.findMany({
      where: { active: true, nextDate: { lte: tomorrow }, user: { setup: true, telegramId: { not: null } } },
      select: { name: true, user: { select: { telegramId: true } } },
    });
    for (const d of due) if (d.user.telegramId) await sendBillAlert(d.user.telegramId, d.name);
  } catch (e) { console.error("Bill alerts err:", e); }
}

module.exports = { bot, sendMorningBriefing, sendBillAlert, runDailyBriefings, runBillAlerts };
