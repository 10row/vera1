// server/telegram.js
// Telegram bot handler. Tool use for reliable categorization.
// Two-tier: Haiku (tool use) for fast intent, Sonnet (tool use) for full conversation.

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const { getState, saveAction, getOrCreateUser } = require("./db/queries");
const { computePicture } = require("./vera");
const { buildSystemPrompt } = require("./prompt");
const { extractIntent, intentToActions } = require("./intent");

const anthropic = new Anthropic();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;

// In-memory pending setup data keyed by user.id.
// Bridged between propose_setup (from Vera) and confirm_setup (button tap).
// Fine to lose on restart — user just re-sends their info.
const pendingSetups = new Map();

// In-memory pending receipt data keyed by user.id.
// Stored after photo scan, cleared on confirm or skip.
const pendingReceipts = new Map();

// In-memory setup conversation history keyed by user.id.
// Allows multi-turn setup without losing context. Cleared on confirm/cancel.
const setupConversations = new Map();

// ── UTILS ─────────────────────────────────────────────────────────────────────
const daysUntil = (ds) => {
  if (!ds) return 99;
  return Math.ceil((new Date(ds + "T00:00:00") - new Date(new Date().toISOString().split("T")[0] + "T00:00:00")) / 86400000);
};
const fmt  = (usd) => `$${(usd || 0).toFixed(0)}`;
const fmtL = (usd, rate, sym) => rate !== 1 ? `${sym}${Math.round((usd || 0) * rate).toLocaleString()}` : "";

// ── LIVE RATE FETCH ────────────────────────────────────────────────────────────
// Free API — no key required. Returns local-currency-per-USD.
async function fetchLiveRate(currency) {
  if (!currency || currency === "USD") return 1;
  try {
    const res  = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    if (data.result === "success" && data.rates?.[currency]) {
      return Math.round(data.rates[currency] * 100) / 100; // 2dp
    }
  } catch (err) {
    console.error("Rate fetch error:", err.message);
  }
  return null;
}

// Intercept action before saving — auto-fetch live rate for set_location / propose_setup
async function enrichActionWithRate(action) {
  const currency =
    action.type === "set_location"   ? action.data?.spendCurrency :
    action.type === "propose_setup"  ? action.data?.spendCurrency :
    null;

  if (currency && currency !== "USD") {
    const live = await fetchLiveRate(currency);
    if (live) action.data.localRate = live;
  }
  return action;
}

// ── VERA TOOLS ────────────────────────────────────────────────────────────────
// Full action set. parentId/subId are enums — Claude cannot hallucinate categories.
const VERA_TOOLS = [
  {
    name: "transaction",
    description: "Record money spent — purchase, bill payment, or expense",
    input_schema: {
      type: "object",
      required: ["description", "amountUSD", "parentId", "subId", "date"],
      properties: {
        description:   { type: "string" },
        amountUSD:     { type: "number" },
        localAmount:   { type: "number" },
        localCurrency: { type: "string" },
        parentId: {
          type: "string",
          enum: ["food_drink","transport","home","health_body","clothing","work_business","entertainment","education","travel","financial"]
        },
        subId: {
          type: "string",
          enum: ["cafes","groceries","restaurants","bars","meal_plan","rideshare","public","flights","fuel","rent","utilities","laundry","supplies","gym","supplements","medical","grooming","activewear","everyday","software","equipment","coworking","streaming","events","hobbies","courses","books","accommodation","visas","investment","fees"]
        },
        date: { type: "string" }
      }
    }
  },
  {
    name: "income",
    description: "Record income received — starts a new cycle",
    input_schema: {
      type: "object",
      required: ["amountUSD", "date"],
      properties: {
        amountUSD:        { type: "number" },
        description:      { type: "string" },
        date:             { type: "string" },
        nextPayday:       { type: "string" },
        expectedIncomeUSD: { type: "number" }
      }
    }
  },
  {
    name: "set_committed",
    description: "Add or update a recurring bill/obligation (NOT a payment)",
    input_schema: {
      type: "object",
      required: ["name", "amountUSD", "frequency"],
      properties: {
        name:               { type: "string" },
        amountUSD:          { type: "number" },
        frequency:          { type: "string", enum: ["monthly","weekly","annual","once"] },
        nextDate:           { type: "string" },
        autoPay:            { type: "boolean" },
        parkedForNextCycle: { type: "boolean" }
      }
    }
  },
  {
    name: "remove_committed",
    description: "Remove / deactivate a committed bill",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    }
  },
  {
    name: "confirm_payment",
    description: "Mark a committed bill as paid this cycle",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    }
  },
  {
    name: "set_envelope",
    description: "Add or update a spending envelope",
    input_schema: {
      type: "object",
      required: ["name", "type"],
      properties: {
        name:            { type: "string" },
        type:            { type: "string", enum: ["daily","monthly","project"] },
        dailyAmountUSD:  { type: "number", description: "For daily envelopes" },
        allocatedUSD:    { type: "number", description: "For monthly/project envelopes" },
        linkedParentId:  { type: "string" },
        reserveFromPool: { type: "boolean" },
        rollover:        { type: "boolean" }
      }
    }
  },
  {
    name: "remove_envelope",
    description: "Remove / deactivate an envelope",
    input_schema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } }
    }
  },
  {
    name: "set_location",
    description: "Update spending location and exchange rate. Include spendCurrency so the system can auto-fetch the live rate.",
    input_schema: {
      type: "object",
      properties: {
        localRate:     { type: "number" },
        spendCurrency: { type: "string" },
        spendSymbol:   { type: "string" },
        location:      { type: "string" },
        locationFlag:  { type: "string" }
      }
    }
  },
  {
    name: "correction",
    description: "Correct balance to match bank statement",
    input_schema: {
      type: "object",
      required: ["amountUSD"],
      properties: {
        amountUSD: { type: "number" },
        note:      { type: "string" }
      }
    }
  },
  {
    name: "set_saving_rate",
    description: "Update the saving rate",
    input_schema: {
      type: "object",
      required: ["rate"],
      properties: {
        rate: { type: "number", description: "0.0–1.0, e.g. 0.10 for 10%" }
      }
    }
  },
  {
    name: "propose_setup",
    description: "Propose initial setup for a new user. Always include location/currency.",
    input_schema: {
      type: "object",
      required: ["balanceUSD", "payday"],
      properties: {
        balanceUSD:        { type: "number" },
        payday:            { type: "string" },
        expectedIncomeUSD: { type: "number" },
        savingRate:        { type: "number" },
        localRate:         { type: "number" },
        spendCurrency:     { type: "string" },
        spendSymbol:       { type: "string" },
        location:          { type: "string" },
        locationFlag:      { type: "string" },
        committed:         { type: "array",  items: { type: "object" } },
        envelopes:         { type: "array",  items: { type: "object" } },
        transactions:      { type: "array",  items: { type: "object" } }
      }
    }
  },
  {
    name: "confirm_setup",
    description: "Confirm and finalise the proposed setup",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "cancel_setup",
    description: "Cancel the proposed setup",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "create_custom_sub",
    description: "Create a custom subcategory",
    input_schema: {
      type: "object",
      required: ["parentId", "label"],
      properties: {
        parentId: { type: "string" },
        label:    { type: "string" },
        keywords: { type: "array", items: { type: "string" } }
      }
    }
  }
];

// ── KEYBOARDS ─────────────────────────────────────────────────────────────────
const mainKeyboard = () => {
  const kb = new InlineKeyboard()
    .text("💸 Spent", "quick_spent")
    .text("💰 Received", "quick_received")
    .text("📌 Coming up", "quick_coming")
    .row()
    .text("📊 My Picture", "show_picture");
  if (process.env.MINIAPP_URL) kb.webApp("Open Spend Kitty ↗", process.env.MINIAPP_URL);
  return kb;
};

const setupConfirmKeyboard = () =>
  new InlineKeyboard()
    .text("✓ Looks good", "confirm_setup")
    .text("✗ Fix something", "cancel_setup");

const billPaidKeyboard = (billName) =>
  new InlineKeyboard()
    .text(`✓ Paid ${billName}`, `paid:${billName}`)
    .text("Not yet", "show_picture");

const settingsKeyboard = () =>
  new InlineKeyboard()
    .text("🔄 Refresh rate", "settings_refresh_rate")
    .text("✏️ Change location", "settings_change_location");

const receiptKeyboard = () =>
  new InlineKeyboard()
    .text("✓ Log it", "receipt_confirm")
    .text("✗ Skip", "receipt_skip");

// ── REPLY FORMATTING ──────────────────────────────────────────────────────────
function formatActionReply(pic, state, lastTx) {
  const rate = state.location?.localRate || 1;
  const sym  = state.location?.symbol || "$";
  const hasLocal = rate !== 1;
  const foodEnv  = pic.computedEnvelopes?.find((e) => e.type === "daily");
  const isFood   = lastTx?.parentId === "food_drink";

  const fmtBoth = (usd) => {
    const localStr = hasLocal ? `  ${fmtL(usd, rate, sym)}` : "";
    return `${fmt(usd)}${localStr}`;
  };

  const lines = ["```"];

  if (isFood && foodEnv) {
    lines.push(`Food today    ${fmtBoth(foodEnv.dailyLeft)}`);
    lines.push(`Free today    ${fmt(pic.freeToday)}`);
  } else {
    lines.push(`Free today    ${fmtBoth(pic.freeToday)}`);
    if (foodEnv) lines.push(`Food today    ${fmtBoth(foodEnv.dailyLeft)}`);
  }

  lines.push(`Payday        ${pic.daysLeft} days`);
  lines.push("```");

  const dueSoon = (pic.imminentBills || []).filter((c) => !c.paidThisCycle);
  if (dueSoon.length && lastTx) {
    const bill = dueSoon[0];
    const days = daysUntil(bill.nextDate);
    const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    lines.push(`\n⚠ *${bill.name}* due ${when} — ${fmt(bill.amountUSD)}`);
  }

  if (pic.freeToday < 2 && pic.trulyFree > 0) {
    lines.push(`\nTruly free: ${fmt(pic.trulyFree)} over ${pic.daysLeft} days. Tight.`);
  } else if (pic.trulyFree < 0) {
    lines.push(`\nFree pool negative — check Picture.`);
  }

  return lines.join("\n");
}

function formatPicture(pic, state) {
  const rate = state.location?.localRate || 1;
  const sym  = state.location?.symbol || "$";
  const hasLocal = rate !== 1;
  const foodEnv  = pic.computedEnvelopes?.find((e) => e.type === "daily");
  const f  = (usd) => fmt(usd).padStart(6);
  const fl = (usd) => hasLocal ? `  ${fmtL(usd, rate, sym)}` : "";

  return [
    "```",
    `Balance     ${f(pic.confirmedBalance)}${fl(pic.confirmedBalance)}`,
    `────────────────────────────────`,
    `Bills due − ${f(pic.bucket1)}${fl(pic.bucket1)}`,
    `Planned   − ${f(pic.bucket2)}${fl(pic.bucket2)}`,
    `Daily     − ${f(pic.bucket3)}${fl(pic.bucket3)}`,
    `────────────────────────────────`,
    `Truly free  ${f(pic.trulyFree)}${fl(pic.trulyFree)}`,
    `Free today  ${f(pic.freeToday)}${fl(pic.freeToday)}`,
    foodEnv ? `Food today  ${f(foodEnv.dailyLeft)}${fl(foodEnv.dailyLeft)} left` : null,
    `────────────────────────────────`,
    `Payday      ${pic.payday || "not set"}   ${pic.daysLeft}d`,
    "```",
  ].filter(Boolean).join("\n");
}

function formatMorningBriefing(pic, state) {
  const rate = state.location?.localRate || 1;
  const sym  = state.location?.symbol || "$";
  const hasLocal = rate !== 1;
  const foodEnv  = pic.computedEnvelopes?.find((e) => e.type === "daily");

  const fmtBoth = (usd) => {
    const localStr = hasLocal ? `  ${fmtL(usd, rate, sym)}` : "";
    return `${fmt(usd)}${localStr}`;
  };

  const lines = [
    "Good morning.",
    "",
    "```",
    `Free today    ${fmtBoth(pic.freeToday)}`,
    foodEnv ? `Food today    ${fmtBoth(foodEnv.dailyLeft)}` : null,
    `Payday        ${pic.daysLeft} days`,
    "```",
  ].filter(Boolean);

  const urgent = (pic.imminentBills || []).filter((c) => !c.paidThisCycle);
  if (urgent.length) {
    lines.push("");
    for (const bill of urgent) {
      const days = daysUntil(bill.nextDate);
      const when = days <= 0 ? "today" : "tomorrow";
      lines.push(`⚠ *${bill.name}* due ${when} — ${fmt(bill.amountUSD)}`);
    }
  }

  return lines.join("\n");
}

function formatBillAlert(bill, pic, state) {
  const rate = state.location?.localRate || 1;
  const sym  = state.location?.symbol || "$";
  const hasLocal = rate !== 1;
  const days = daysUntil(bill.nextDate);
  const when = days <= 0 ? "due today" : "due tomorrow";

  return [
    `⚠ *${bill.name}* is ${when}`,
    "",
    "```",
    `Amount    ${fmt(bill.amountUSD)}${hasLocal ? `  ${fmtL(bill.amountUSD, rate, sym)}` : ""}`,
    `Free now  ${fmt(pic.trulyFree)}${hasLocal ? `  ${fmtL(pic.trulyFree, rate, sym)}` : ""}`,
    "```",
  ].join("\n");
}

function formatSetupConfirmation(pendingSetup, daysLeft) {
  const rate = pendingSetup.localRate || 1;
  const sym  = pendingSetup.spendSymbol || "$";
  const hasLocal = rate !== 1;
  const f  = (usd) => `$${(usd || 0).toFixed(0)}`;
  const fl = (usd) => hasLocal ? `  ${sym}${Math.round((usd || 0) * rate).toLocaleString()}` : "";

  const lines = [
    "```",
    `Balance      ${f(pendingSetup.balanceUSD)}${fl(pendingSetup.balanceUSD)}`,
    `Payday       ${pendingSetup.payday} (${daysLeft} days)`,
    `Income       ${f(pendingSetup.expectedIncomeUSD)}`,
    `Saving       ${((pendingSetup.savingRate || 0.10) * 100).toFixed(0)}%`,
    hasLocal ? `Currency     ${sym} (${pendingSetup.spendCurrency})  at ${sym}${rate}/$` : null,
    "```",
  ].filter(Boolean);

  if (pendingSetup.committed?.length) {
    lines.push("\nBills");
    lines.push("```");
    for (const c of pendingSetup.committed) {
      lines.push(`${c.name.padEnd(20)} ${f(c.amountUSD)}/${(c.frequency || "mo").slice(0, 2)}`);
    }
    lines.push("```");
  }

  const foodEnv = pendingSetup.envelopes?.find((e) => e.type === "daily");
  if (foodEnv) {
    const daily = foodEnv.dailyAmountUSD || 0;
    lines.push(`\n🍽 Food ${f(daily)}/day · ${f(daily * daysLeft)} this cycle`);
  }

  if (pendingSetup.location) {
    lines.push(`\n📍 ${pendingSetup.locationFlag || ""} ${pendingSetup.location}`);
  }

  return lines.join("\n");
}

function formatSettings(state) {
  const loc = state.location;
  if (!loc) return "No location set yet. Tell me where you are and what currency you spend in.";
  const hasLocal = (loc.localRate || 1) !== 1;
  return [
    "*Location & Currency*",
    "```",
    `Location  ${loc.name || "not set"}  ${loc.flag || ""}`,
    `Currency  ${loc.spendCurrency || "USD"}  ${loc.symbol || "$"}`,
    hasLocal ? `Rate      ${loc.symbol}${loc.localRate}  per $1 USD` : "Rate      1:1 (USD)",
    `Updated   ${loc.rateUpdated || "never"}`,
    "```",
  ].join("\n");
}

// ── FULL VERA CONVERSATION — TOOL USE ─────────────────────────────────────────
async function callVera(messages, state) {
  const pic    = computePicture(state);
  const system = buildSystemPrompt(pic, state);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools: VERA_TOOLS,
    tool_choice: { type: "auto" },
  });

  // Extract actions from tool calls
  const toolUses = response.content.filter(b => b.type === "tool_use");
  const actions  = toolUses.map(b => ({ type: b.name, data: b.input }));

  // Extract message from text blocks
  let message = response.content.filter(b => b.type === "text").map(b => b.text).join("").trim();

  // If Claude stopped to wait for tool results and gave no text yet, do a quick follow-up
  if (!message && toolUses.length > 0 && response.stop_reason === "tool_use") {
    const toolResults = toolUses.map(b => ({
      type: "tool_result",
      tool_use_id: b.id,
      content: "Saved.",
    }));
    const followUp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", // Haiku for the short voice response
      max_tokens: 200,
      system,
      messages: [
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: "assistant", content: response.content },
        { role: "user",      content: toolResults },
      ],
    });
    message = followUp.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  }

  return { message: message || "Got it.", actions };
}

// ── APPLY ACTIONS WITH RATE ENRICHMENT ────────────────────────────────────────
async function applyActions(userId, actions) {
  let newState;
  for (const action of actions) {
    await enrichActionWithRate(action); // auto-fetch live rate if currency present
    newState = await saveAction(prisma, userId, action);
  }
  return newState;
}

// ── SHARED: process a text message through Vera and reply ─────────────────────
async function processMessage(ctx, telegramId, text) {
  const user  = await getOrCreateUser(prisma, telegramId);
  const state = await getState(prisma, user.id);

  // Not set up yet — go straight to full Vera with conversation history
  if (!state.setup) {
    const history = setupConversations.get(user.id) || [];
    history.push({ role: "user", content: text });

    const r = await callVera(history, state);

    // Append assistant reply to history for next turn
    if (r.message) history.push({ role: "assistant", content: r.message });
    setupConversations.set(user.id, history.slice(-10)); // keep last 10 messages

    const setupAction = r.actions?.find(a => a.type === "propose_setup");
    if (setupAction) {
      await enrichActionWithRate(setupAction);
      pendingSetups.set(user.id, setupAction.data);
      setupConversations.delete(user.id); // clear history once setup proposed
      const daysLeft = setupAction.data?.payday
        ? Math.max(1, Math.ceil((new Date(setupAction.data.payday + "T00:00:00") - new Date()) / 86400000))
        : 13;
      await ctx.reply(
        (r.message ? r.message + "\n\n" : "") + formatSetupConfirmation(setupAction.data, daysLeft),
        { parse_mode: "Markdown", reply_markup: setupConfirmKeyboard() }
      );
      return;
    }

    await ctx.reply(r.message || "Got it.");
    return;
  }

  // Set up — try fast Haiku intent extraction first
  const intent = await extractIntent(text, state);
  const isConversational = ["conversation", "show_picture"].includes(intent.type);

  if (!isConversational) {
    const actions = intentToActions(intent, state);
    if (actions?.length) {
      let newState = state;
      for (const action of actions) {
        await enrichActionWithRate(action);
        newState = await saveAction(prisma, user.id, action);
      }

      const pic    = computePicture(newState);
      const txData = actions.find(a => a.type === "transaction")?.data;
      const sym    = newState.location?.symbol || "$";
      const rate   = newState.location?.localRate || 1;
      const hasLocal = rate !== 1;

      let header = "";
      if (txData?.amountUSD) {
        const icon      = txData.parentId === "food_drink" ? "🍽" : "💸";
        const localPart = hasLocal && txData.localAmount ? `${sym}${Math.round(txData.localAmount)}  ·  ` : "";
        header = `${icon} *${txData.description}*  ${localPart}${fmt(txData.amountUSD)}\n\n`;
      } else if (intent.type === "set_committed") {
        header = `📌 *${intent.data?.name}* set — ${fmt(intent.data?.amountUSD)}/${(intent.data?.frequency || "mo").slice(0, 2)}\n\n`;
      } else if (intent.type === "set_envelope") {
        header = `📋 *${intent.data?.name}* envelope set\n\n`;
      } else if (intent.type === "set_location") {
        const loc = newState.location;
        const rateStr = loc?.localRate && loc.localRate !== 1 ? `${loc.symbol}${loc.localRate}/$` : "";
        header = `📍 *${loc?.name || "Location"}* updated${rateStr ? `  ${rateStr}` : ""}\n\n`;
      } else if (intent.type === "income") {
        header = `💰 *Income logged* — ${fmt(intent.data?.amountUSD)}\n\n`;
      }

      const numbers = formatActionReply(pic, newState, txData);
      await ctx.reply(header + numbers, { parse_mode: "Markdown", reply_markup: mainKeyboard() });

      // Income debrief
      if (intent.type === "income" && pic.prevCycleSpend) {
        const top = Object.entries(pic.prevCycleSpend.byCategory)
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k, v]) => `  ${k.replace(/_/g, " ")}  ${fmt(v)}`).join("\n");
        setTimeout(async () => {
          await ctx.reply(
            `Last cycle: ${fmt(pic.prevCycleSpend.total)} total\n\`\`\`\n${top}\n\`\`\`\nNew cycle — ${pic.daysLeft} days.`,
            { parse_mode: "Markdown" }
          );
        }, 800);
      }
      return;
    }
  }

  if (intent.type === "show_picture") {
    const pic = computePicture(state);
    await ctx.reply(formatPicture(pic, state), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    return;
  }

  // Full Vera conversation (Sonnet + tool use)
  const r = await callVera([{ role: "user", content: text }], state);

  const setupAction = r.actions?.find(a => a.type === "propose_setup");
  if (setupAction) {
    await enrichActionWithRate(setupAction);
    pendingSetups.set(user.id, setupAction.data);
    const daysLeft = setupAction.data?.payday
      ? Math.max(1, Math.ceil((new Date(setupAction.data.payday + "T00:00:00") - new Date()) / 86400000))
      : 13;
    await ctx.reply(
      (r.message ? r.message + "\n\n" : "") + formatSetupConfirmation(setupAction.data, daysLeft),
      { parse_mode: "Markdown", reply_markup: setupConfirmKeyboard() }
    );
    return;
  }

  // Apply all other actions
  let newState = state;
  for (const action of (r.actions || [])) {
    await enrichActionWithRate(action);
    newState = await saveAction(prisma, user.id, action);
  }

  await ctx.reply(r.message || "Got it.", { parse_mode: "Markdown", reply_markup: mainKeyboard() });
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

// ── VOICE MESSAGE HANDLER ─────────────────────────────────────────────────────
if (bot) bot.on("message:voice", async (ctx) => {
  if (!process.env.OPENAI_API_KEY) {
    await ctx.reply("Voice messages aren't enabled yet. Type it instead.");
    return;
  }
  try {
    await ctx.reply("_transcribing…_", { parse_mode: "Markdown" });
    const file    = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer   = await response.arrayBuffer();
    const OpenAI   = require("openai");
    const openai   = new OpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], "voice.ogg", { type: "audio/ogg" }),
      model: "whisper-1",
    });
    const text = transcription.text;
    if (!text) { await ctx.reply("Couldn't catch that. Try again."); return; }
    await processMessage(ctx, ctx.from.id, text);
  } catch (err) {
    console.error("Voice handler error:", err);
    await ctx.reply("Couldn't process that voice message.");
  }
});

// ── PHOTO / RECEIPT HANDLER ───────────────────────────────────────────────────
if (bot) bot.on("message:photo", async (ctx) => {
  try {
    const user  = await getOrCreateUser(prisma, ctx.from.id);
    const state = await getState(prisma, user.id);

    if (!state.setup) {
      await ctx.reply("Set yourself up first. Send me your balance and payday.");
      return;
    }

    await ctx.reply("_reading receipt…_", { parse_mode: "Markdown" });

    // Grab the highest-resolution photo Telegram provides
    const photos  = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const file    = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const imgRes    = await fetch(fileUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const b64       = Buffer.from(imgBuffer).toString("base64");

    const rate = state.location?.localRate || 1;
    const sym  = state.location?.symbol || "$";

    const receiptTool = {
      name: "extract_receipt",
      description: "Extract the total amount and best-fit category from a receipt photo",
      input_schema: {
        type: "object",
        required: ["description", "amountLocal", "parentId", "subId"],
        properties: {
          description: { type: "string", description: "Short description, e.g. 'Lunch at Som Tam Nua'" },
          amountLocal:  { type: "number", description: "Total amount as shown on the receipt" },
          currency:     { type: "string", description: "Currency code or symbol seen on the receipt, e.g. THB, USD, $" },
          note:         { type: "string", description: "Optional: any useful detail (e.g. '3 items')" },
          parentId: {
            type: "string",
            enum: ["food_drink","transport","home","health_body","clothing","work_business","entertainment","education","travel","financial"]
          },
          subId: {
            type: "string",
            enum: ["cafes","groceries","restaurants","bars","meal_plan","rideshare","public","flights","fuel","rent","utilities","laundry","supplies","gym","supplements","medical","grooming","activewear","everyday","software","equipment","coworking","streaming","events","hobbies","courses","books","accommodation","visas","investment","fees"]
          }
        }
      }
    };

    const visionResp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: b64 }
          },
          {
            type: "text",
            text: `Extract the total amount and category from this receipt. If multiple items, use the grand total. Use the extract_receipt tool.`
          }
        ]
      }],
      tools: [receiptTool],
      tool_choice: { type: "any" }
    });

    const toolUse = visionResp.content.find(b => b.type === "tool_use");
    if (!toolUse) {
      await ctx.reply("Couldn't read that receipt. Try a clearer photo or type it manually.");
      return;
    }

    const r = toolUse.input;
    const amountUSD = rate !== 1 ? r.amountLocal / rate : r.amountLocal;

    // Store pending receipt
    pendingReceipts.set(user.id, {
      description:   r.description,
      amountUSD:     Math.round(amountUSD * 100) / 100,
      localAmount:   rate !== 1 ? r.amountLocal : null,
      localCurrency: rate !== 1 ? (state.location?.spendCurrency || null) : null,
      parentId:      r.parentId,
      subId:         r.subId,
      date:          new Date().toISOString().split("T")[0],
      note:          r.note || null,
    });

    const localStr = rate !== 1 ? `${sym}${Math.round(r.amountLocal).toLocaleString()}  ·  ` : "";
    const catStr   = `${r.parentId.replace(/_/g, " ")} > ${r.subId}`;
    const noteStr  = r.note ? `\n_${r.note}_` : "";

    await ctx.reply(
      `📄 *${r.description}*\n${localStr}${fmt(amountUSD)}  ·  ${catStr}${noteStr}\n\nLog this?`,
      { parse_mode: "Markdown", reply_markup: receiptKeyboard() }
    );

  } catch (err) {
    console.error("Photo handler error:", err);
    await ctx.reply("Couldn't read that photo. Type the expense manually.");
  }
});

// ── /settings COMMAND ────────────────────────────────────────────────────────
if (bot) bot.command("settings", async (ctx) => {
  try {
    const user  = await getOrCreateUser(prisma, ctx.from.id);
    const state = await getState(prisma, user.id);
    if (!state.setup) { await ctx.reply("Not set up yet. Send me your balance and payday to get started."); return; }
    await ctx.reply(formatSettings(state), { parse_mode: "Markdown", reply_markup: settingsKeyboard() });
  } catch (err) {
    console.error("Settings error:", err);
  }
});

// ── /start COMMAND ────────────────────────────────────────────────────────────
if (bot) bot.command("start", async (ctx) => {
  try {
    const user  = await getOrCreateUser(prisma, ctx.from.id);
    const state = await getState(prisma, user.id);
    if (state.setup) {
      const pic = computePicture(state);
      await ctx.reply(formatPicture(pic, state), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
    } else {
      await ctx.reply("Hey, I'm Kitty. Tell me your situation — balance, when you get paid, what's coming out. And where are you based?");
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
    const user  = await getOrCreateUser(prisma, ctx.from.id);
    const state = await getState(prisma, user.id);
    const pic   = computePicture(state);
    const sym   = state.location?.symbol || "$";
    const rate  = state.location?.localRate || 1;

    // ── Quick prompts ──────────────────────────────────────────────────────
    if (data === "quick_spent") {
      const foodEnv = pic.computedEnvelopes?.find((e) => e.type === "daily");
      const hint = rate !== 1
        ? (foodEnv ? `e.g. _"lunch ${sym}200"_ or _"coffee ${sym}80"_` : `e.g. _"lunch ${sym}200"_ or _"$25 Grab"_`)
        : `e.g. _"lunch $12"_ or _"Grab $8"_`;
      await ctx.reply(`What did you spend?\n${hint}`, { parse_mode: "Markdown" });
      return;
    }

    if (data === "quick_received") {
      await ctx.reply(
        "What came in?\ne.g. _\"got paid $3,200\"_ or _\"friend paid me back $50\"_",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (data === "quick_coming") {
      const ex = rate !== 1
        ? `_"gym ${sym}2,000 due the 14th"_ or _"supplements $50 this cycle"_`
        : `_"gym $80 due the 14th"_ or _"supplements $50 this cycle"_`;
      await ctx.reply(`What's coming up?\ne.g. ${ex}`, { parse_mode: "Markdown" });
      return;
    }

    // ── Show picture ───────────────────────────────────────────────────────
    if (data === "show_picture") {
      await ctx.reply(formatPicture(pic, state), { parse_mode: "Markdown", reply_markup: mainKeyboard() });
      return;
    }

    // ── Setup confirm/cancel ───────────────────────────────────────────────
    if (data === "confirm_setup") {
      const pending = pendingSetups.get(user.id);
      if (!pending) {
        await ctx.editMessageText(
          "That setup expired. Tell me your situation again and I'll re-propose it.",
          { reply_markup: undefined }
        );
        return;
      }
      // complete_setup persists everything to DB and sets setup:true
      const newState = await saveAction(prisma, user.id, { type: "complete_setup", data: pending });
      pendingSetups.delete(user.id);
      const newPic  = computePicture(newState);
      const foodEnv = newPic.computedEnvelopes?.find((e) => e.type === "daily");
      const locStr  = newState.location?.name ? ` · ${newState.location.flag || ""} ${newState.location.name}` : "";
      await ctx.editMessageText(
        `You're set.\n\n\`\`\`\nFree today    ${fmt(newPic.freeToday)}\n${foodEnv ? `Food today    ${fmt(foodEnv.dailyLeft)}\n` : ""}Payday        ${newPic.daysLeft} days\`\`\`${locStr}`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

    if (data === "cancel_setup") {
      pendingSetups.delete(user.id);
      setupConversations.delete(user.id);
      await ctx.editMessageText("What would you like to change? Tell me your situation again.");
      return;
    }

    // ── Bill paid ──────────────────────────────────────────────────────────
    if (data.startsWith("paid:")) {
      const billName  = data.slice(5);
      const committed = state.committed?.[billName.toLowerCase()];
      if (!committed) { await ctx.reply("Couldn't find that bill."); return; }

      const currency = state.location?.spendCurrency || "USD";
      const actions  = [
        {
          type: "transaction",
          data: {
            description: billName,
            amountUSD: committed.amountUSD,
            localAmount: rate !== 1 ? Math.round(committed.amountUSD * rate) : null,
            localCurrency: rate !== 1 ? currency : null,
            parentId: "financial",
            subId: "fees",
            date: new Date().toISOString().split("T")[0],
          },
        },
        { type: "confirm_payment", data: { name: billName } },
      ];

      let newState = state;
      for (const action of actions) newState = await saveAction(prisma, user.id, action);
      const newPic = computePicture(newState);

      await ctx.editMessageText(
        `✓ *${billName}* paid.\n\n${formatActionReply(newPic, newState, null)}`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

    // ── Receipt confirm/skip ───────────────────────────────────────────────
    if (data === "receipt_confirm") {
      const receipt = pendingReceipts.get(user.id);
      if (!receipt) {
        await ctx.editMessageText("That receipt expired. Send the photo again.", { reply_markup: undefined });
        return;
      }
      const newState = await saveAction(prisma, user.id, { type: "transaction", data: receipt });
      pendingReceipts.delete(user.id);
      const newPic = computePicture(newState);
      await ctx.editMessageText(
        `✓ *${receipt.description}* logged.\n\n${formatActionReply(newPic, newState, receipt)}`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

    if (data === "receipt_skip") {
      pendingReceipts.delete(user.id);
      await ctx.editMessageText("Skipped. Send it again or type it manually.", { reply_markup: undefined });
      return;
    }

    // ── Settings: refresh rate ─────────────────────────────────────────────
    if (data === "settings_refresh_rate") {
      const currency = state.location?.spendCurrency;
      if (!currency || currency === "USD") {
        await ctx.answerCallbackQuery("Already on USD — no rate needed.");
        return;
      }
      const live = await fetchLiveRate(currency);
      if (!live) {
        await ctx.reply("Couldn't fetch live rate right now. Try again later.");
        return;
      }
      await saveAction(prisma, user.id, {
        type: "set_location",
        data: { ...state.location, localRate: live },
      });
      await ctx.editMessageText(
        formatSettings({ ...state, location: { ...state.location, localRate: live, rateUpdated: new Date().toISOString().split("T")[0] } }),
        { parse_mode: "Markdown", reply_markup: settingsKeyboard() }
      );
      return;
    }

    // ── Settings: change location ──────────────────────────────────────────
    if (data === "settings_change_location") {
      await ctx.reply(
        "Tell me where you are now.\ne.g. _\"I'm in Japan\"_ or _\"moved to Georgia, currency GEL\"_",
        { parse_mode: "Markdown" }
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
    const user  = await getOrCreateUser(prisma, String(telegramId));
    const state = await getState(prisma, user.id);
    if (!state.setup) return;
    const pic = computePicture(state);
    await bot.api.sendMessage(telegramId, formatMorningBriefing(pic, state), {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
  } catch (err) {
    console.error("Morning briefing error:", err);
  }
}

async function sendBillAlert(telegramId, billName) {
  if (!bot) return;
  try {
    const user  = await getOrCreateUser(prisma, String(telegramId));
    const state = await getState(prisma, user.id);
    if (!state.setup) return;
    const bill = state.committed?.[billName.toLowerCase()];
    if (!bill) return;
    const pic = computePicture(state);
    await bot.api.sendMessage(telegramId, formatBillAlert(bill, pic, state), {
      parse_mode: "Markdown",
      reply_markup: billPaidKeyboard(billName),
    });
  } catch (err) {
    console.error("Bill alert error:", err);
  }
}

module.exports = { bot, callVera, enrichActionWithRate, sendMorningBriefing, sendBillAlert };
