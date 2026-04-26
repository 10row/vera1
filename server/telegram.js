"use strict";

// server/telegram.js — SpendYes v2 Telegram Bot
// Uses v2 engine (vera-v2.js) with Prisma/Postgres persistence.
// Single-tier: Sonnet with JSON output format (same as web client).

const Anthropic = require("@anthropic-ai/sdk");
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v2 = require("./vera-v2");

const anthropic = new Anthropic();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;

// In-memory pending setups (fine to lose on restart)
const pendingSetups = new Map();

// ── UTILS ─────────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function daysUntil(ds) {
  if (!ds) return 99;
  return Math.ceil((new Date(ds + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000);
}
function fmt(cents) {
  if (cents == null) return "$0";
  const neg = cents < 0; const abs = Math.abs(cents);
  return (neg ? "-" : "") + "$" + Math.floor(abs / 100).toLocaleString();
}

// ── KEYBOARDS ─────────────────────────────────────────────────────────────────
const mainKeyboard = () =>
  new InlineKeyboard()
    .text("💸 Spent", "quick_spent")
    .text("💰 Received", "quick_received")
    .text("📌 Coming up", "quick_coming")
    .row()
    .text("📊 My Picture", "show_picture");

const setupConfirmKeyboard = () =>
  new InlineKeyboard()
    .text("✓ Looks good", "confirm_setup")
    .text("✗ Fix something", "cancel_setup");

const billActionKeyboard = (billName) =>
  new InlineKeyboard()
    .text("✓ Paid " + billName, "paid:" + billName)
    .text("Skip", "skip:" + billName);

// ── FORMATTING ────────────────────────────────────────────────────────────────
function formatPicture(pic) {
  if (!pic.setup) return "Not set up yet. Send me your balance and payday to get started.";
  const f = (c) => fmt(c).padStart(8);
  const lines = [
    "```",
    "Balance    " + f(pic.balanceCents),
    "─────────────────────────",
    "Bills    − " + f(pic.billsReservedCents),
    "Planned  − " + f(pic.plannedTotalCents),
    "Pools    − " + f(pic.poolReserveCents),
    "─────────────────────────",
    "Free       " + f(pic.trulyFreeCents),
    "Free today " + f(pic.freeRemainingTodayCents),
    "Daily pace " + f(pic.dailyFreePaceCents),
    "─────────────────────────",
    "Payday     " + (pic.payday || "not set") + "  " + pic.daysLeft + "d",
    "```",
  ];

  // Due bills
  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    lines.push("");
    for (const b of dueBills) {
      lines.push("⚠ *" + b.name + "* due — " + fmt(b.amountCents || 0));
    }
  }

  return lines.join("\n");
}

function formatActionReply(pic) {
  const lines = ["```"];
  lines.push("Free today    " + fmt(pic.freeRemainingTodayCents));
  lines.push("Daily pace    " + fmt(pic.dailyFreePaceCents));
  lines.push("Payday        " + pic.daysLeft + " days");
  lines.push("```");

  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    const bill = dueBills[0];
    lines.push("\n⚠ *" + bill.name + "* is due — " + fmt(bill.amountCents || 0));
  }

  if (pic.freeRemainingTodayCents < 200 && pic.trulyFreeCents > 0) {
    lines.push("\nTruly free: " + fmt(pic.trulyFreeCents) + " over " + pic.daysLeft + " days. Tight.");
  } else if (pic.trulyFreeCents < 0) {
    lines.push("\nFree pool negative — check Picture.");
  }

  return lines.join("\n");
}

function formatMorningBriefing(pic) {
  const dueBills = pic.drains.filter(d => d.isDue);
  const isTight = pic.freeRemainingTodayCents < 500 && pic.trulyFreeCents >= 0;
  const isNegative = pic.trulyFreeCents < 0;

  const lines = [];
  if (isNegative) lines.push("Morning. Bills exceed your balance — something needs attention.");
  else if (isTight) lines.push("Morning. Tight day — " + fmt(pic.freeRemainingTodayCents) + " free.");
  else lines.push("Morning.");

  lines.push("");
  lines.push("```");
  lines.push("Free today    " + fmt(pic.freeRemainingTodayCents));
  lines.push("Daily pace    " + fmt(pic.dailyFreePaceCents));
  lines.push("Payday        " + (pic.daysLeft === 0 ? "today" : pic.daysLeft + " days"));
  lines.push("```");

  if (dueBills.length) {
    lines.push("");
    for (const bill of dueBills) {
      lines.push("⚠ *" + bill.name + "* due — " + fmt(bill.amountCents || 0));
    }
  }

  return lines.join("\n");
}

function formatBillAlert(drain, pic) {
  const days = daysUntil(drain.nextDate);
  const when = days <= 0 ? "due today" : "due tomorrow";
  return [
    "⚠ *" + drain.name + "* is " + when,
    "",
    "```",
    "Amount    " + fmt(drain.amountCents),
    "Free now  " + fmt(pic.trulyFreeCents),
    "```",
  ].join("\n");
}

function formatSetupConfirmation(data, daysLeft) {
  return [
    "```",
    "Balance      " + fmt(v2.toCents(data.balanceUSD)),
    "Payday       " + (data.payday || "?") + " (" + daysLeft + " days)",
    "Income       " + fmt(v2.toCents(data.incomeUSD)),
    "Saving       " + ((data.savingRate || 0.10) * 100).toFixed(0) + "%",
    "```",
  ].join("\n");
}

// ── CALL SPENDYES (Sonnet, JSON format — same as web) ─────────────────────────
async function callSpendYes(state, userMessage) {
  const history = (state.conversationHistory || []).slice(-20);
  history.push({ role: "user", content: userMessage });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: v2.buildSystemPrompt(state),
    messages: history,
  });

  const text = response.content?.[0]?.text ?? "";
  let parsed;
  const jm = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jm) { parsed = JSON.parse(jm[1]); }
  else { try { parsed = JSON.parse(text); } catch { parsed = { message: text, actions: [{ type: "none" }] }; } }

  return { text, parsed };
}

// ── GET USER + STATE ──────────────────────────────────────────────────────────
async function getUserAndState(telegramId) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
  if (!user) user = await prisma.user.create({ data: { telegramId: String(telegramId) } });
  const state = await db.loadState(prisma, user.id);
  return { user, state };
}

// ── PROCESS MESSAGE ───────────────────────────────────────────────────────────
async function processMessage(ctx, telegramId, text) {
  const { user, state } = await getUserAndState(telegramId);

  // Call SpendYes AI
  const { text: rawText, parsed } = await callSpendYes(state, text);

  // Save conversation history
  state.conversationHistory.push({ role: "user", content: text });
  state.conversationHistory.push({ role: "assistant", content: rawText });
  if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);

  // Apply actions
  let newState = state;
  for (const action of (parsed.actions || [])) {
    newState = v2.applyAction(newState, action);
  }

  // Persist
  await db.saveState(prisma, user.id, newState);
  await db.saveMessages(prisma, user.id, newState.conversationHistory);

  // Reply
  const pic = v2.computePicture(newState);
  const hasSetup = parsed.actions?.some(a => a.type === "setup");
  const hasTransaction = parsed.actions?.some(a => a.type === "transaction" || a.type === "income" || a.type === "confirm_payment" || a.type === "confirm_planned");

  if (hasSetup || hasTransaction) {
    const msg = (parsed.message || "Got it.") + "\n\n" + formatActionReply(pic);
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard() });

    // After first setup, invite bills
    if (hasSetup && !state.setup) {
      setTimeout(async () => {
        await ctx.reply(
          "Now — any regular bills I should know about? Rent, subscriptions, gym, anything recurring.\n\nJust tell me in plain English. Or say skip and we're done.",
          { parse_mode: "Markdown" }
        );
      }, 800);
    }
  } else {
    await ctx.reply(parsed.message || "Got it.", { parse_mode: "Markdown", reply_markup: newState.setup ? mainKeyboard() : undefined });
  }
}

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
if (bot) bot.on("message:text", async (ctx) => {
  try {
    await processMessage(ctx, ctx.from.id, ctx.message.text);
  } catch (err) {
    console.error("Message handler error:", err);
    await ctx.reply("Something went wrong. Try again.");
  }
});

// ── VOICE HANDLER ─────────────────────────────────────────────────────────────
if (bot) bot.on("message:voice", async (ctx) => {
  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply("Voice isn't enabled. Type it instead.");
    return;
  }
  try {
    await ctx.reply("_transcribing…_", { parse_mode: "Markdown" });
    const file = await ctx.getFile();
    const fileUrl = "https://api.telegram.org/file/bot" + process.env.BOT_TOKEN + "/" + file.file_path;
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    const OpenAI = require("openai");
    const openai = new OpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], "voice.ogg", { type: "audio/ogg" }),
      model: "whisper-1",
    });
    if (!transcription.text) { await ctx.reply("Couldn't catch that. Try again."); return; }
    await processMessage(ctx, ctx.from.id, transcription.text);
  } catch (err) {
    console.error("Voice handler error:", err);
    await ctx.reply("Couldn't process that voice message.");
  }
});

// ── PHOTO / RECEIPT HANDLER ───────────────────────────────────────────────────
if (bot) bot.on("message:photo", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    if (!state.setup) { await ctx.reply("Set yourself up first. Send me your balance and payday."); return; }

    await ctx.reply("_reading receipt…_", { parse_mode: "Markdown" });

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
          { type: "text", text: "Extract the total amount and a short description from this receipt. Reply with JSON: {\"description\": \"...\", \"amountUSD\": number}. If there's a foreign currency amount, include \"localAmount\" and \"currency\" fields too." }
        ]
      }],
    });

    const receiptText = receiptResp.content?.[0]?.text ?? "";
    let receipt;
    try { receipt = JSON.parse(receiptText); } catch {
      const jm = receiptText.match(/\{[\s\S]*\}/);
      if (jm) receipt = JSON.parse(jm[0]);
      else { await ctx.reply("Couldn't read that receipt. Type it manually."); return; }
    }

    if (!receipt.amountUSD || !receipt.description) {
      await ctx.reply("Couldn't read that receipt. Type it manually.");
      return;
    }

    // Auto-log it as a transaction
    let newState = v2.applyAction(state, {
      type: "transaction",
      data: { description: receipt.description, amountUSD: receipt.amountUSD }
    });
    await db.saveState(prisma, user.id, newState);

    const pic = v2.computePicture(newState);
    await ctx.reply(
      "📄 *" + receipt.description + "* — " + fmt(v2.toCents(receipt.amountUSD)) + "\n\n" + formatActionReply(pic),
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
  } catch (err) {
    console.error("Photo handler error:", err);
    await ctx.reply("Couldn't read that photo. Type the expense manually.");
  }
});

// ── /start COMMAND ────────────────────────────────────────────────────────────
if (bot) bot.command("start", async (ctx) => {
  try {
    const { state } = await getUserAndState(ctx.from.id);
    if (state.setup) {
      const pic = v2.computePicture(state);
      await ctx.reply(formatPicture(pic), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    } else {
      await ctx.reply("Hey, I'm SpendYes — your spending confidence engine.\n\nTwo things to start: what's your balance right now, and when do you next get paid?");
    }
  } catch (err) {
    console.error("Start error:", err);
  }
});

// ── CALLBACK QUERIES ──────────────────────────────────────────────────────────
if (bot) bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();

  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    const pic = v2.computePicture(state);

    // Quick prompts
    if (data === "quick_spent") {
      await ctx.reply("What did you spend?\ne.g. _\"lunch $12\"_ or _\"coffee $5\"_", { parse_mode: "Markdown" });
      return;
    }
    if (data === "quick_received") {
      await ctx.reply("What came in?\ne.g. _\"got paid $3,200\"_ or _\"friend paid me back $50\"_", { parse_mode: "Markdown" });
      return;
    }
    if (data === "quick_coming") {
      await ctx.reply("What's coming up?\ne.g. _\"gym $80 due the 14th\"_ or _\"trip $1000 next month\"_", { parse_mode: "Markdown" });
      return;
    }

    // Show picture
    if (data === "show_picture") {
      await ctx.reply(formatPicture(pic), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
      return;
    }

    // Bill paid
    if (data.startsWith("paid:")) {
      const billName = data.slice(5);
      let newState = v2.applyAction(state, { type: "confirm_payment", data: { name: billName } });
      await db.saveState(prisma, user.id, newState);
      const newPic = v2.computePicture(newState);
      await ctx.editMessageText(
        "✓ *" + billName + "* paid.\n\n" + formatActionReply(newPic),
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

    // Bill skip
    if (data.startsWith("skip:")) {
      const billName = data.slice(5);
      let newState = v2.applyAction(state, { type: "skip_payment", data: { name: billName } });
      await db.saveState(prisma, user.id, newState);
      const newPic = v2.computePicture(newState);
      await ctx.editMessageText(
        "Skipped *" + billName + "* — next date advanced.\n\n" + formatActionReply(newPic),
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

  } catch (err) {
    console.error("Callback handler error:", err);
  }
});

// ── PROACTIVE MESSAGES ────────────────────────────────────────────────────────
async function sendMorningBriefing(telegramId) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(telegramId);
    if (!state.setup) return;
    const pic = v2.computePicture(state);
    await bot.api.sendMessage(telegramId, formatMorningBriefing(pic), {
      parse_mode: "Markdown", reply_markup: mainKeyboard(),
    });
  } catch (err) {
    console.error("Morning briefing error:", err);
  }
}

async function sendBillAlert(telegramId, billName) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(telegramId);
    if (!state.setup) return;
    const key = billName.toLowerCase().trim();
    const drain = state.drains[key];
    if (!drain) return;
    const pic = v2.computePicture(state);
    await bot.api.sendMessage(telegramId, formatBillAlert(drain, pic), {
      parse_mode: "Markdown", reply_markup: billActionKeyboard(billName),
    });
  } catch (err) {
    console.error("Bill alert error:", err);
  }
}

module.exports = { bot, sendMorningBriefing, sendBillAlert };
