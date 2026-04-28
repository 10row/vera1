"use strict";
// telegram-v3.js — V3 Telegram bot handler
// Voice-first. Envelopes. No monospace. Hero number on every change.

const Anthropic = require("@anthropic-ai/sdk").default;
const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const { Bot } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v3 = require("./vera-v3");
const { runQuery } = require("./vera-v3-query");
const { callSpendYes, callReview } = require("./tg-ai-v3");
const fmt = require("./tg-format-v3");

let logApiCall = async () => {};
try {
  const a = require("./admin");
  if (a && typeof a.logApiCall === "function") logApiCall = a.logApiCall;
} catch (e) { console.warn("Admin logging unavailable:", e.message); }

const anthropic = new Anthropic();
const openai = new OpenAI();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;

// Pending receipts (expire after 30 min)
const pendingReceipts = new Map();
setInterval(() => {
  const cutoff = Date.now() - 1800000;
  for (const [k, v] of pendingReceipts) {
    if (v.ts < cutoff) pendingReceipts.delete(k);
  }
}, 600000);

// ── SAFE REPLY ────────────────────────────────
async function safeReply(ctx, text, opts = {}) {
  try { return await ctx.reply(text, opts); }
  catch (e) {
    if (e.message?.includes("can't parse")) {
      const o = { ...opts }; delete o.parse_mode;
      return await ctx.reply(text, o);
    }
    throw e;
  }
}
async function safeEdit(ctx, text, opts = {}) {
  try { return await ctx.editMessageText(text, opts); }
  catch (e) {
    if (e.message?.includes("can't parse")) {
      const o = { ...opts }; delete o.parse_mode;
      return await ctx.editMessageText(text, o);
    }
    throw e;
  }
}

// ── USER HELPERS ──────────────────────────────
async function getUserAndState(telegramId) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
  if (!user) user = await prisma.user.create({ data: { telegramId: String(telegramId) } });
  return { user, state: await db.loadState(prisma, user.id) };
}

async function ensureLanguage(ctx, user, state) {
  if (state.setup) return state.language || "en";
  const d = fmt.detectLang(ctx);
  if (state.language !== d) {
    state.language = d;
    await prisma.user.update({ where: { id: user.id }, data: { language: d } });
  }
  return state.language || "en";
}

// ── PROCESS MESSAGE ───────────────────────────
// Core handler: text or transcribed voice → AI → apply actions → reply
async function processMessage(ctx, telegramId, text) {
  const { user } = await getUserAndState(telegramId);
  await ctx.replyWithChatAction("typing");

  await db.withUserLock(user.id, async () => {
    let state = await db.loadState(prisma, user.id);
    const lang = await ensureLanguage(ctx, user, state);
    const miniAppUrl = process.env.MINIAPP_URL || null;

    // Refresh typing indicator before AI call
    await ctx.replyWithChatAction("typing").catch(() => {});

    // Call AI
    const { text: raw, parsed } = await callSpendYes(state, text, user.id);

    // If verify flag is set, ask for confirmation without committing
    if (parsed.verify) {
      state.conversationHistory.push({ role: "user", content: text });
      state.conversationHistory.push({ role: "assistant", content: raw });
      if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);
      await db.saveState(prisma, user.id, state);
      await safeReply(ctx, parsed.message || "Something seems off — can you confirm?", {
        parse_mode: "Markdown",
        reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
      });
      return;
    }

    // Save conversation
    state.conversationHistory.push({ role: "user", content: text });
    state.conversationHistory.push({ role: "assistant", content: raw });
    if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);

    // Save undo snapshot before applying actions (one per user message)
    const hasStateChange = (parsed.actions || []).some(a => a.type !== "none");
    if (hasStateChange) {
      state.undoSnapshot = JSON.parse(JSON.stringify(state));
      delete state.undoSnapshot.undoSnapshot; // don't nest
    }

    // Handle reset — full /start experience
    const hasReset = (parsed.actions || []).some(a => a.type === "reset");
    if (hasReset) {
      await prisma.$transaction([
        prisma.transaction.deleteMany({ where: { userId: user.id } }),
        prisma.envelope.deleteMany({ where: { userId: user.id } }),
        prisma.monthlySummary.deleteMany({ where: { userId: user.id } }),
        prisma.cycleSummary.deleteMany({ where: { userId: user.id } }),
        prisma.message.deleteMany({ where: { userId: user.id } }),
        prisma.user.update({
          where: { id: user.id },
          data: {
            setup: false, balanceCents: 0, incomeCents: 0,
            payday: null, cycleStart: null, language: lang,
          },
        }),
      ]);
      // Send full welcome message — identical to /start for a new user
      await ctx.reply(fmt.t(lang, "welcome"), { parse_mode: "Markdown" });
      return;
    } else {
      // Apply actions
      for (const a of (parsed.actions || [])) {
        if (a.type !== "none") state = v3.applyAction(state, a);
      }

      // Run queries
      const qr = {};
      for (const q of (parsed.queries || [])) {
        qr[q.type] = runQuery(state, q, v3.computePicture, v3.toMoney);
      }

      await db.saveState(prisma, user.id, state);
    }

    // Build reply
    const pic = v3.computePicture(state);
    let msg = parsed.message || "Got it.";

    // Ensure hero number is present for state changes
    if (hasStateChange && state.setup) {
      const hero = fmt.heroLine(pic, lang);
      if (hero && !msg.includes("Free today") && !msg.includes("Сегодня")) {
        msg = msg.trimEnd() + "\n" + hero;
      }
    }

    // Surface due envelopes after action
    const due = pic.dueEnvelopes || [];
    if (due.length > 0 && !hasReset) {
      const dueEnv = due[0];
      await safeReply(ctx, msg, {
        parse_mode: "Markdown",
        reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
      });
      // Send due alert as separate message with pay/skip buttons
      const alertMsg = fmt.formatEnvelopeAlert(dueEnv, pic, lang, state.timezone);
      await safeReply(ctx, alertMsg, {
        parse_mode: "Markdown",
        reply_markup: fmt.dueButtons(dueEnv.name, lang),
      });
    } else {
      await safeReply(ctx, msg, {
        parse_mode: "Markdown",
        reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
      });
    }
  });
}

// ── REPLY KEYBOARD (review button) — must register BEFORE message:text ──
if (bot) bot.hears(/How'm I doing|Как дела/i, async (ctx) => {
  try {
    const { user } = await getUserAndState(ctx.from.id);
    await db.withUserLock(user.id, async () => {
      const state = await db.loadState(prisma, user.id);
      const lang = state.language || fmt.detectLang(ctx);
      const miniAppUrl = process.env.MINIAPP_URL || null;
      if (!state.setup) {
        await ctx.reply(fmt.t(lang, "notSetup"));
        return;
      }
      await ctx.replyWithChatAction("typing");
      const rv = await callReview(state, user.id);
      state.conversationHistory.push({
        role: "user",
        content: lang === "ru" ? "Как дела?" : "How'm I doing?",
      });
      state.conversationHistory.push({ role: "assistant", content: rv });
      if (state.conversationHistory.length > 40) {
        state.conversationHistory = state.conversationHistory.slice(-30);
      }
      await db.saveState(prisma, user.id, state);
      await safeReply(ctx, rv, {
        parse_mode: "Markdown",
        reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
      });
    });
  } catch (err) {
    console.error("Review err:", err);
    await ctx.reply(fmt.t(fmt.detectLang(ctx), "error")).catch(() => {});
  }
});

// ── RESET INTERCEPT (text-level, before AI) ──────
const RESET_PATTERNS = /^(reset|start over|wipe|clear everything|начать заново|сброс|очистить)$/i;

async function handleResetDirect(ctx, telegramId) {
  const tid = String(telegramId);
  const user = await prisma.user.findUnique({ where: { telegramId: tid } });
  const lang = user
    ? (await db.loadState(prisma, user.id)).language || fmt.detectLang(ctx)
    : fmt.detectLang(ctx);
  if (user) {
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: user.id } }),
      prisma.envelope.deleteMany({ where: { userId: user.id } }),
      prisma.monthlySummary.deleteMany({ where: { userId: user.id } }),
      prisma.cycleSummary.deleteMany({ where: { userId: user.id } }),
      prisma.message.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          setup: false, balanceCents: 0, incomeCents: 0,
          payday: null, cycleStart: null, language: lang,
        },
      }),
    ]);
  }
  // Full /start welcome — not just "clean slate"
  await ctx.reply(fmt.t(lang, "welcome"), { parse_mode: "Markdown" });
}

// ── GREETING INTERCEPT (non-setup users) ─────────
const GREETING_PATTERNS = /^(hi|hello|hey|yo|sup|start|привет|хай|здравствуйте|начать)$/i;

// ── TEXT MESSAGES ──────────────────────────────
if (bot) bot.on("message:text", async (ctx) => {
  try {
    const text = ctx.message.text;
    if (text.length > 2000) {
      await ctx.reply("Message too long. Keep it under 2000 characters.");
      return;
    }

    // Intercept reset keywords — bypass AI entirely
    if (RESET_PATTERNS.test(text.trim())) {
      await handleResetDirect(ctx, ctx.from.id);
      return;
    }

    // Intercept greetings for non-setup users — show voice-first welcome
    if (GREETING_PATTERNS.test(text.trim())) {
      const { state } = await getUserAndState(ctx.from.id);
      if (!state.setup) {
        const lang = fmt.detectLang(ctx);
        await ctx.reply(fmt.t(lang, "welcome"), { parse_mode: "Markdown" });
        return;
      }
    }

    await processMessage(ctx, ctx.from.id, text);
  } catch (err) {
    console.error("Msg err:", err);
    await ctx.reply(fmt.t(fmt.detectLang(ctx), "error")).catch(() => {});
  }
});

// ── VOICE MESSAGES ────────────────────────────
if (bot) bot.on("message:voice", async (ctx) => {
  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply("Voice not enabled.");
    return;
  }

  // Instant visible feedback — user knows we received the voice
  const lang = fmt.detectLang(ctx);
  let statusMsg;
  try {
    statusMsg = await ctx.reply("🎙");
  } catch (e) { /* non-critical */ }

  // Keep typing indicator alive throughout pipeline
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  try {
    await ctx.replyWithChatAction("typing");
    const t0 = Date.now();

    // 1. Download voice file (10s timeout)
    const file = await ctx.getFile();
    const url = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const dlController = new AbortController();
    const dlTimer = setTimeout(() => dlController.abort(), 10000);
    const resp = await fetch(url, { signal: dlController.signal });
    const buf = Buffer.from(await resp.arrayBuffer());
    clearTimeout(dlTimer);
    console.log(`Voice download: ${Date.now() - t0}ms, ${buf.length} bytes`);

    // 2. Whisper transcription — use SDK toFile() + timeout option (NOT AbortController)
    const t1 = Date.now();
    const audioFile = await toFile(buf, "voice.ogg", { type: "audio/ogg" });
    const tr = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    }, { timeout: 15000 });
    console.log(`Whisper: ${Date.now() - t1}ms, text="${(tr.text || "").slice(0, 60)}"`);

    if (!tr.text) {
      clearInterval(typingInterval);
      const noText = lang === "ru" ? "Не расслышал, попробуй ещё раз." : "Couldn't catch that.";
      if (statusMsg) await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, noText).catch(() => ctx.reply(noText));
      else await ctx.reply(noText);
      return;
    }
    const voiceText = tr.text.length > 2000 ? tr.text.slice(0, 2000) : tr.text;

    // Delete the 🎙 status message before AI reply comes through
    if (statusMsg) {
      ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }

    console.log(`Voice pipeline pre-AI: ${Date.now() - t0}ms total`);
    await processMessage(ctx, ctx.from.id, voiceText);
  } catch (err) {
    console.error("Voice err:", err);
    const errMsg = lang === "ru" ? "Что-то пошло не так, попробуй ещё раз." : "Something went wrong, try again.";
    if (statusMsg) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errMsg).catch(() => ctx.reply(fmt.t(lang, "error")).catch(() => {}));
    } else {
      await ctx.reply(fmt.t(lang, "error")).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
  }
});

// ── PHOTO (RECEIPT) ───────────────────────────
if (bot) bot.on("message:photo", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = state.language || fmt.detectLang(ctx);
    if (!state.setup) {
      await ctx.reply(fmt.t(lang, "notSetup"));
      return;
    }
    await ctx.replyWithChatAction("typing");
    await ctx.reply(fmt.t(lang, "receiptReading"), { parse_mode: "Markdown" });

    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const file = await ctx.api.getFile(largest.file_id);
    const url = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const b64 = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64");

    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
          { type: "text", text: 'Extract total amount and short description from this receipt. Reply JSON: {"description":"...","amountUSD":number}. If foreign currency, estimate USD equivalent.' },
        ],
      }],
    });
    const rU = resp.usage || {};
    logApiCall(user.id, "claude-haiku-4-5-20251001", rU.input_tokens || 0, rU.output_tokens || 0, "receipt").catch(() => {});

    const rt = resp.content?.[0]?.text ?? "";
    let rc;
    try {
      rc = JSON.parse(rt);
    } catch {
      const m = rt.match(/\{[\s\S]*\}/);
      if (m) rc = JSON.parse(m[0]);
      else { await ctx.reply(fmt.t(lang, "receiptFailed")); return; }
    }
    if (!rc.amountUSD || !rc.description) {
      await ctx.reply(fmt.t(lang, "receiptFailed"));
      return;
    }

    pendingReceipts.set(String(ctx.from.id), {
      description: rc.description,
      amountUSD: rc.amountUSD,
      userId: user.id,
      ts: Date.now(),
    });

    const sym = state.currencySymbol || "$";
    const amtFmt = v3.toMoney(v3.toCents(rc.amountUSD), sym);
    const msg = lang === "ru"
      ? "Я прочитал: *" + rc.description + "* — " + amtFmt + "\n\nЗаписать?"
      : "I read: *" + rc.description + "* — " + amtFmt + "\n\nShould I log this?";

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: fmt.receiptButtons(lang),
    });
  } catch (err) {
    console.error("Photo err:", err);
    await ctx.reply(fmt.t(fmt.detectLang(ctx), "receiptFailed")).catch(() => {});
  }
});

// ── /start COMMAND ────────────────────────────
if (bot) bot.command("start", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = await ensureLanguage(ctx, user, state);
    const miniAppUrl = process.env.MINIAPP_URL || null;

    if (state.setup) {
      const pic = v3.computePicture(state);
      const sym = state.currencySymbol || "$";
      const M = c => v3.toMoney(c, sym);
      const ft = pic.freeRemainingTodayFormatted || M(pic.freeRemainingTodayCents || 0);
      const dp = pic.dailyPaceFormatted || M(pic.dailyPaceCents || 0);
      const dl = pic.daysLeft ?? "?";

      let g;
      if (pic.freeCents < 0) {
        g = lang === "ru"
          ? "Привет. Сейчас перерасход. " + ft + " свободно."
          : "Hey. Things are tight. " + ft + " free today.";
      } else if (dl <= 3) {
        g = lang === "ru"
          ? "Почти зарплата! " + ft + " свободно."
          : "Almost payday! " + ft + " free today.";
      } else {
        g = lang === "ru"
          ? ft + " свободно, " + dp + "/день, " + dl + " дн."
          : ft + " free today, " + dp + "/day, " + dl + " days.";
      }

      await safeReply(ctx, g, {
        parse_mode: "Markdown",
        reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
      });
    } else {
      await ctx.reply(fmt.t(lang, "welcome"), { parse_mode: "Markdown" });
    }
  } catch (err) { console.error("Start err:", err); }
});

// ── /app COMMAND ──────────────────────────────
// Inline-keyboard `web_app` button is the most reliable Mini App launch
// for surfacing initData on every Telegram client.
if (bot) bot.command("app", async (ctx) => {
  try {
    const miniAppUrl = process.env.MINIAPP_URL;
    if (!miniAppUrl) {
      await ctx.reply("Mini App is not configured (MINIAPP_URL is missing on the server).");
      return;
    }
    const lang = fmt.detectLang(ctx);
    const label = lang === "ru" ? "Открыть приложение" : "Open Dashboard";
    await ctx.reply(lang === "ru" ? "Открой свою панель:" : "Open your dashboard:", {
      reply_markup: {
        inline_keyboard: [[{ text: label, web_app: { url: miniAppUrl } }]],
      },
    });
  } catch (err) { console.error("/app err:", err); }
});

// ── /reset COMMAND ────────────────────────────
if (bot) bot.command("reset", async (ctx) => {
  try {
    const tid = String(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId: tid } });
    if (!user) {
      await ctx.reply(fmt.t(fmt.detectLang(ctx), "welcome"), { parse_mode: "Markdown" });
      return;
    }
    const lang = (await db.loadState(prisma, user.id)).language || fmt.detectLang(ctx);
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: user.id } }),
      prisma.envelope.deleteMany({ where: { userId: user.id } }),
      prisma.monthlySummary.deleteMany({ where: { userId: user.id } }),
      prisma.cycleSummary.deleteMany({ where: { userId: user.id } }),
      prisma.message.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          setup: false, balanceCents: 0,
          payday: null, cycleStart: null, language: lang,
        },
      }),
    ]);
    await ctx.reply(fmt.t(lang, "welcome"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Reset err:", err);
    await ctx.reply(fmt.t(fmt.detectLang(ctx), "error")).catch(() => {});
  }
});

// ── CALLBACK QUERIES ──────────────────────────
if (bot) bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const lang = state.language || fmt.detectLang(ctx);
    const miniAppUrl = process.env.MINIAPP_URL || null;

    // Review button
    if (data === "review" || ctx.callbackQuery?.message?.text?.includes(fmt.t(lang, "review"))) {
      if (!state.setup) {
        await ctx.reply(fmt.t(lang, "notSetup"));
        return;
      }
      await db.withUserLock(user.id, async () => {
        const freshState = await db.loadState(prisma, user.id);
        await ctx.replyWithChatAction("typing");
        const rv = await callReview(freshState, user.id);
        freshState.conversationHistory.push({
          role: "user",
          content: lang === "ru" ? "Как дела?" : "How'm I doing?",
        });
        freshState.conversationHistory.push({ role: "assistant", content: rv });
        if (freshState.conversationHistory.length > 40) {
          freshState.conversationHistory = freshState.conversationHistory.slice(-30);
        }
        await db.saveState(prisma, user.id, freshState);
        await safeReply(ctx, rv, {
          parse_mode: "Markdown",
          reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
        });
      });
      return;
    }

    // Receipt confirm
    if (data === "receipt:confirm") {
      const rc = pendingReceipts.get(String(ctx.from.id));
      if (!rc) { await ctx.reply("No pending receipt."); return; }
      pendingReceipts.delete(String(ctx.from.id));
      await db.withUserLock(user.id, async () => {
        let ns = await db.loadState(prisma, user.id);
        ns = v3.applyAction(ns, {
          type: "spend",
          data: { description: rc.description, amountUSD: rc.amountUSD },
        });
        await db.saveState(prisma, user.id, ns);
        const pic = v3.computePicture(ns);
        const sym = ns.currencySymbol || "$";
        const amtFmt = v3.toMoney(v3.toCents(rc.amountUSD), sym);
        const msg = (lang === "ru"
          ? "✓ Записано *" + rc.description + "* — " + amtFmt
          : "✓ Logged *" + rc.description + "* — " + amtFmt)
          + "\n" + fmt.heroLine(pic, lang);
        await safeEdit(ctx, msg, {
          parse_mode: "Markdown",
        });
      });
      return;
    }

    // Receipt edit / cancel
    if (data === "receipt:edit") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(fmt.t(lang, "receiptEdit"), { parse_mode: "Markdown" });
      return;
    }
    if (data === "receipt:cancel") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(lang === "ru" ? "Отменено." : "Cancelled.", { parse_mode: "Markdown" });
      return;
    }

    // Pay envelope
    if (data.startsWith("pay:")) {
      const envName = data.slice(4);
      await db.withUserLock(user.id, async () => {
        let ns = await db.loadState(prisma, user.id);
        ns = v3.applyAction(ns, { type: "pay_envelope", data: { name: envName } });
        await db.saveState(prisma, user.id, ns);
        const pic = v3.computePicture(ns);
        const msg = fmt.t(lang, "paidConfirm").replace("NAME", envName)
          + "\n" + fmt.heroLine(pic, lang);
        await safeEdit(ctx, msg, { parse_mode: "Markdown" });
      });
      return;
    }

    // Skip envelope
    if (data.startsWith("skip:")) {
      const envName = data.slice(5);
      await db.withUserLock(user.id, async () => {
        let ns = await db.loadState(prisma, user.id);
        ns = v3.applyAction(ns, { type: "skip_envelope", data: { name: envName } });
        await db.saveState(prisma, user.id, ns);
        const pic = v3.computePicture(ns);
        const msg = fmt.t(lang, "skippedConfirm").replace("NAME", envName)
          + "\n" + fmt.heroLine(pic, lang);
        await safeEdit(ctx, msg, { parse_mode: "Markdown" });
      });
      return;
    }
  } catch (err) { console.error("CB err:", err); }
});

// (review hears handler moved above message:text to prevent double-fire)

// ── PROACTIVE: MORNING BRIEFINGS ──────────────
async function sendMorningBriefing(tid) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(tid);
    if (!state.setup) return;
    const lang = state.language || "en";
    const pic = v3.computePicture(state);
    const miniAppUrl = process.env.MINIAPP_URL || null;
    await bot.api.sendMessage(tid, fmt.formatBriefing(pic, lang), {
      parse_mode: "Markdown",
      reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
    });
  } catch (e) { console.error("Briefing err:", e); }
}

// ── PROACTIVE: BILL/ENVELOPE ALERTS ───────────
async function sendEnvelopeAlert(tid, envName) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(tid);
    if (!state.setup) return;
    const lang = state.language || "en";
    const key = envName.toLowerCase().trim().replace(/\s+/g, "_");
    const env = state.envelopes[key];
    if (!env || !env.active) return;
    const pic = v3.computePicture(state);
    await bot.api.sendMessage(tid, fmt.formatEnvelopeAlert(env, pic, lang, state.timezone), {
      parse_mode: "Markdown",
      reply_markup: fmt.dueButtons(env.name, lang),
    });
  } catch (e) { console.error("Envelope alert err:", e); }
}

function localHour(tz) {
  try { return parseInt(new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false })); }
  catch { return new Date().getUTCHours(); }
}

async function runDailyBriefings() {
  try {
    const users = await prisma.user.findMany({
      where: { setup: true, telegramId: { not: null } },
      select: { telegramId: true, timezone: true },
    });
    let sent = 0;
    for (const u of users) {
      if (!u.telegramId) continue;
      const h = localHour(u.timezone || "UTC");
      if (h === 8) { await sendMorningBriefing(u.telegramId); sent++; }
    }
    if (sent > 0) console.log("Briefings sent:", sent);
  } catch (e) { console.error("Briefings err:", e); }
}

async function runEnvelopeAlerts() {
  try {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const dueEnvelopes = await prisma.envelope.findMany({
      where: {
        active: true,
        nextDate: { lte: tomorrow },
        user: { setup: true, telegramId: { not: null } },
      },
      select: {
        name: true,
        user: { select: { telegramId: true } },
      },
    });
    for (const e of dueEnvelopes) {
      if (e.user.telegramId) await sendEnvelopeAlert(e.user.telegramId, e.name);
    }
  } catch (e) { console.error("Envelope alerts err:", e); }
}

// ── PROACTIVE: RECONCILIATION ─────────────────
async function runReconciliation() {
  try {
    const users = await prisma.user.findMany({
      where: { setup: true, telegramId: { not: null } },
      select: { telegramId: true, id: true },
    });
    for (const u of users) {
      if (!u.telegramId) continue;
      const state = await db.loadState(prisma, u.id);
      const lang = state.language || "en";
      const pic = v3.computePicture(state);
      const miniAppUrl = process.env.MINIAPP_URL || null;
      await bot.api.sendMessage(u.telegramId, fmt.formatReconciliation(pic, lang), {
        parse_mode: "Markdown",
        reply_markup: fmt.mainKeyboard(lang, miniAppUrl),
      });
    }
  } catch (e) { console.error("Reconciliation err:", e); }
}

module.exports = {
  bot,
  sendMorningBriefing,
  sendEnvelopeAlert,
  runDailyBriefings,
  runEnvelopeAlerts,
  runReconciliation,
};
