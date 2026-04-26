"use strict";

// server/telegram.js - SpendYes v2 Telegram Bot
// Uses v2 engine (vera-v2.js) with Prisma/Postgres persistence.
// Single-tier: Sonnet with JSON output format (same as web client).

const Anthropic = require("@anthropic-ai/sdk").default;
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v2 = require("./vera-v2");

const anthropic = new Anthropic();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;

// -- UTILS
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

// -- KEYBOARDS
const mainKeyboard = () =>
  new InlineKeyboard()
    .text("\xf0\x9f\x92\xb8 Spent", "quick_spent")
    .text("\xf0\x9f\x92\xb0 Received", "quick_received")
    .row()
    .text("\xf0\x9f\xa7\xa0 How'm I doing?", "review")
    .row()
    .text("\xf0\x9f\x93\x8a My Picture", "show_picture");

const billActionKeyboard = (billName) =>
  new InlineKeyboard()
    .text("\xe2\x9c\x93 Paid " + billName, "paid:" + billName)
    .text("Skip", "skip:" + billName);

// -- FORMATTING
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

// -- CALL SPENDYES (Sonnet, JSON format - for actions)
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

// -- CALL REVIEW (Sonnet, pure conversational - no JSON, no actions)
async function callReview(state) {
  const pic = v2.computePicture(state);
  const txCount = state.transactions.length;
  const recentTx = state.transactions.slice(-15).map(t =>
    t.date + " | " + t.type + " | " + v2.toUSD(t.amountCents) + " | " + (t.description || t.node || "")
  ).join("\n");

  const drainsList = Object.values(state.drains).filter(d => d.active).map(d =>
    d.name + ": " + v2.toUSD(d.amountCents) + " every " + d.intervalDays + "d, next: " + (d.nextDate || "?")
  ).join("\n");

  const poolsList = Object.values(state.pools).filter(p => p.active).map(p =>
    p.name + ": spent " + v2.toUSD(p.spentCents) + (p.type === "daily" ? " (budget " + v2.toUSD(p.dailyCents) + "/day)" : " (budget " + v2.toUSD(p.allocatedCents) + "/mo)")
  ).join("\n");

  const prompt = `You are SpendYes, a personal finance companion on Telegram. The user just tapped "How'm I doing?" They want a genuine, insightful check-in on their financial situation.

THEIR NUMBERS:
- Balance: ${v2.toUSD(state.balanceCents)}
- Truly free: ${v2.toUSD(pic.trulyFreeCents)}
- Free today: ${v2.toUSD(pic.freeRemainingTodayCents)}
- Daily pace: ${v2.toUSD(pic.dailyFreePaceCents)}
- Days to payday: ${pic.daysLeft}
- Savings: ${v2.toUSD(state.savingsCents)} (${(state.savingRateBps / 100)}%)
- Total transactions logged: ${txCount}
${pic.cycleStats ? "- This cycle: spent " + v2.toUSD(pic.cycleStats.spentCents) + ", avg " + v2.toUSD(pic.cycleStats.avgDailyCents) + "/day" : ""}

BILLS:
${drainsList || "(none)"}

SPENDING POOLS:
${poolsList || "(none)"}

RECENT ACTIVITY:
${recentTx || "(no transactions yet)"}

YOUR JOB:
Write a short, personal check-in (3-6 sentences max). Be real. Talk like a sharp friend who happens to be great with money.

- If they're doing well, tell them specifically why and what they can feel good about
- If things are tight, be honest but not scary. Name the thing that's squeezing them
- Notice patterns in their recent spending. Call out anything interesting
- If you see an opportunity (something they could cut, a pattern they might not see), mention it casually
- End with something forward-looking. What to watch for, what's coming up, or what they can afford to enjoy

DO NOT:
- List bullet points or use headers. This is a conversation, not a report
- Repeat numbers they can see in My Picture. Add INSIGHT, not data
- Be generic. Reference their actual spending, their actual bills, their actual situation
- Use emoji excessively. One is fine. Zero is fine too
- Start with "Great news!" or any canned opener. Just talk

Keep it under 120 words. Telegram messages should feel quick to read.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: prompt,
    messages: [{ role: "user", content: "How'm I doing?" }],
  });

  return response.content?.[0]?.text ?? "Couldn't pull your review right now. Try again in a sec.";
}

// -- GET USER + STATE
async function getUserAndState(telegramId) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
  if (!user) user = await prisma.user.create({ data: { telegramId: String(telegramId) } });
  const state = await db.loadState(prisma, user.id);
  return { user, state };
}

// -- CONVERSATIONAL NUDGE (after 3rd and 5th transaction)
function maybeNudge(txCount) {
  if (txCount === 3) {
    return "\n\n_Tip: you can ask me anything — \"can I afford dinner out?\", \"where's my money going?\", \"what should I cut?\" I'm not just buttons._";
  }
  if (txCount === 5) {
    return "\n\n_By the way — try asking \"how'm I doing?\" or \"what did I spend this week?\" I can see patterns you might not._";
  }
  return "";
}

// -- PROCESS MESSAGE
async function processMessage(ctx, telegramId, text) {
  const { user } = await getUserAndState(telegramId);
  await ctx.replyWithChatAction("typing");
  await db.withUserLock(user.id, async () => {
    const state = await db.loadState(prisma, user.id);
    const { text: rawText, parsed } = await callSpendYes(state, text);
    state.conversationHistory.push({ role: "user", content: text });
    state.conversationHistory.push({ role: "assistant", content: rawText });
    if (state.conversationHistory.length > 40) state.conversationHistory = state.conversationHistory.slice(-30);
    let newState = state;
    for (const action of (parsed.actions || [])) {
      newState = v2.applyAction(newState, action);
    }
    await db.saveState(prisma, user.id, newState);
    const pic = v2.computePicture(newState);
    const hasSetup = parsed.actions?.some(a => a.type === "setup");
    const hasTransaction = parsed.actions?.some(a => a.type === "transaction" || a.type === "income" || a.type === "confirm_payment" || a.type === "confirm_planned");
    const nudge = hasTransaction ? maybeNudge(newState.transactions.length) : "";
    if (hasSetup || hasTransaction) {
      const msg = (parsed.message || "Got it.") + "\n\n" + formatActionReply(pic) + nudge;
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
      if (hasSetup && !state.setup) {
        setTimeout(async () => {
          await ctx.reply(
            "Now — any regular bills I should know about? Rent, subscriptions, gym, anything recurring.\n\nJust tell me in plain English. Or say *skip* and we're done.",
            { parse_mode: "Markdown" }
          );
        }, 800);
      }
    } else {
      await ctx.reply(parsed.message || "Got it.", { parse_mode: "Markdown", reply_markup: newState.setup ? mainKeyboard() : undefined });
    }
  });
}

// -- MESSAGE HANDLER
if (bot) bot.on("message:text", async (ctx) => {
  try {
    await processMessage(ctx, ctx.from.id, ctx.message.text);
  } catch (err) {
    console.error("Message handler error:", err);
    await ctx.reply("Something went wrong. Try again.");
  }
});

// -- VOICE HANDLER
if (bot) bot.on("message:voice", async (ctx) => {
  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply("Voice isn't enabled. Type it instead.");
    return;
  }
  try {
    await ctx.replyWithChatAction("typing");
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

// -- PHOTO / RECEIPT HANDLER
if (bot) bot.on("message:photo", async (ctx) => {
  try {
    const { user, state } = await getUserAndState(ctx.from.id);
    if (!state.setup) { await ctx.reply("Set yourself up first. Send me your balance and payday."); return; }
    await ctx.replyWithChatAction("typing");
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
          { type: "text", text: 'Extract the total amount and a short description from this receipt. Reply with JSON: {"description": "...", "amountUSD": number}. If there\'s a foreign currency amount, include "localAmount" and "currency" fields too.' }
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
    await db.withUserLock(user.id, async () => {
      const freshState = await db.loadState(prisma, user.id);
      let newState = v2.applyAction(freshState, {
        type: "transaction",
        data: { description: receipt.description, amountUSD: receipt.amountUSD }
      });
      await db.saveState(prisma, user.id, newState);
      const pic = v2.computePicture(newState);
      const nudge = maybeNudge(newState.transactions.length);
      await ctx.reply(
        "\xf0\x9f\x93\x84 *" + receipt.description + "* — " + fmt(v2.toCents(receipt.amountUSD)) + "\n\n" + formatActionReply(pic) + nudge,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
    });
  } catch (err) {
    console.error("Photo handler error:", err);
    await ctx.reply("Couldn't read that photo. Type the expense manually.");
  }
});

// -- /start COMMAND
if (bot) bot.command("start", async (ctx) => {
  try {
    const { state } = await getUserAndState(ctx.from.id);
    if (state.setup) {
      const pic = v2.computePicture(state);
      const txCount = state.transactions.length;
      let greeting;
      if (txCount === 0) {
        greeting = "Welcome back. You're set up but haven't logged anything yet — just tell me what you spend as it happens. Or ask me anything about your money.";
      } else if (pic.trulyFreeCents < 0) {
        greeting = "Hey. Things are tight right now — your bills are eating more than your balance. Let's look at it together. Tap *How'm I doing?* or just ask me what's going on.";
      } else if (pic.daysLeft <= 3) {
        greeting = "Almost payday. You've got " + fmt(pic.freeRemainingTodayCents) + " free today. Home stretch.";
      } else {
        greeting = "Hey. " + fmt(pic.freeRemainingTodayCents) + " free today, " + fmt(pic.dailyFreePaceCents) + "/day pace, " + pic.daysLeft + " days to payday. You're good.";
      }
      await ctx.reply(greeting + "\n\n" + formatPicture(pic), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    } else {
      await ctx.reply(
        "Hey — I'm SpendYes.\n\nI don't track budgets or nag you about spending. I show you what you *can* spend, freely, with everything accounted for.\n\nTo get started, just tell me two things:\n• What's your bank balance right now?\n• When do you next get paid?\n\nJust type it naturally. Like talking to a friend.",
        { parse_mode: "Markdown" }
      );
    }
  } catch (err) {
    console.error("Start error:", err);
  }
});

// -- CALLBACK QUERIES
if (bot) bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  try {
    const { user, state } = await getUserAndState(ctx.from.id);

    if (data === "quick_spent") {
      await ctx.reply("What did you spend? Just type it — _\"lunch $12\"_ or _\"uber home $23\"_\n\nOr describe it however you want. I'll figure it out.", { parse_mode: "Markdown" });
      return;
    }
    if (data === "quick_received") {
      await ctx.reply("What came in? — _\"got paid $3,200\"_ or _\"friend paid me back $50\"_", { parse_mode: "Markdown" });
      return;
    }

    // -- HOW'M I DOING? (the wow button)
    if (data === "review") {
      if (!state.setup) {
        await ctx.reply("Set yourself up first and log a few things — then I'll have something to tell you.");
        return;
      }
      await ctx.replyWithChatAction("typing");
      const reviewText = await callReview(state);
      await ctx.reply(reviewText, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
      return;
    }

    if (data === "show_picture") {
      const pic = v2.computePicture(state);
      await ctx.reply(formatPicture(pic), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
      return;
    }

    if (data.startsWith("paid:")) {
      const billName = data.slice(5);
      await db.withUserLock(user.id, async () => {
        const freshState = await db.loadState(prisma, user.id);
        let newState = v2.applyAction(freshState, { type: "confirm_payment", data: { name: billName } });
        await db.saveState(prisma, user.id, newState);
        const newPic = v2.computePicture(newState);
        await ctx.editMessageText(
          "✓ *" + billName + "* paid.\n\n" + formatActionReply(newPic),
          { parse_mode: "Markdown", reply_markup: mainKeyboard() }
        );
      });
      return;
    }

    if (data.startsWith("skip:")) {
      const billName = data.slice(5);
      await db.withUserLock(user.id, async () => {
        const freshState = await db.loadState(prisma, user.id);
        let newState = v2.applyAction(freshState, { type: "skip_payment", data: { name: billName } });
        await db.saveState(prisma, user.id, newState);
        const newPic = v2.computePicture(newState);
        await ctx.editMessageText(
          "Skipped *" + billName + "* — next date advanced.\n\n" + formatActionReply(newPic),
          { parse_mode: "Markdown", reply_markup: mainKeyboard() }
        );
      });
      return;
    }
  } catch (err) {
    console.error("Callback handler error:", err);
  }
});

// -- PROACTIVE MESSAGES
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
