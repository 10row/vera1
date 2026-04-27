"use strict";

// server/telegram.js - SpendYes v2 Telegram Bot
// Uses v2 engine (vera-v2.js) with Prisma/Postgres persistence.
// Supports EN/RU via language detection.

const Anthropic = require("@anthropic-ai/sdk").default;
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v2 = require("./vera-v2");

const anthropic = new Anthropic();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;

// -- PENDING RECEIPTS (in-memory, keyed by telegramId — lost on restart is fine)
const pendingReceipts = new Map();

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

// -- LANGUAGE STRINGS
const S = {
  en: {
    spent: "💸 Spent",
    received: "💰 Received",
    review: "🧠 How'm I doing?",
    picture: "📊 My Picture",
    paidBtn: "✓ Paid ",
    skipBtn: "Skip",
    confirmReceipt: "✓ Log it",
    editReceipt: "✏ Edit",
    cancelReceipt: "✗ Cancel",
    receiptReading: "_reading receipt…_",
    receiptRead: "📄 I read: *DESC* — AMT\n\nLog this?",
    receiptLogged: "✓ Logged *DESC* — AMT",
    receiptCancelled: "Cancelled. Type it manually if you want.",
    receiptFailed: "Couldn't read that receipt. Type it manually.",
    receiptEdit: "What's the right amount and description? e.g. _\"coffee $4.50\"_",
    spentPrompt: "What did you spend? Just type it — _\"lunch $12\"_ or _\"uber home $23\"_\n\nOr snap a receipt 📸",
    receivedPrompt: "What came in? — _\"got paid $3,200\"_ or _\"friend paid me back $50\"_",
    notSetup: "Not set up yet. Send me your balance and payday to get started.",
    setupFirst: "Set yourself up first. Send me your balance and payday.",
    setupFirstReview: "Set yourself up first and log a few things — then I'll have something to tell you.",
    error: "Something went wrong. Try again.",
    welcome: "Hey — I'm SpendYes.\n\nI don't track budgets or nag you about spending. I show you what you *can* spend, freely, with everything accounted for.\n\nTo get started, just tell me two things:\n• What's your bank balance right now?\n• When do you next get paid?\n\nJust type it naturally. Like talking to a friend.",
    billsPrompt: "Now — any regular bills I should know about? Rent, subscriptions, gym, anything recurring.\n\nJust tell me in plain English. Or say *skip* and we're done.",
    nudge3: "\n\n_Tip: you can ask me anything — \"can I afford dinner out?\", \"where's my money going?\", \"what should I cut?\" Or just snap a receipt 📸_",
    nudge5: "\n\n_Try asking \"how'm I doing?\" or \"what did I spend this week?\" I can see patterns you might not._",
    balance: "Balance",
    bills: "Bills",
    planned: "Planned",
    pools: "Pools",
    free: "Free",
    freeToday: "Free today",
    dailyPace: "Daily pace",
    payday: "Payday",
    due: "due",
    days: "d",
    daysWord: "days",
    paidConfirm: "✓ *NAME* paid.",
    skippedConfirm: "Skipped *NAME* — next date advanced.",
    resetConfirm: "Everything wiped. Let's start fresh.\n\nTell me your bank balance and when you next get paid.",
    resetFail: "Couldn't reset. Try again.",
  },
  ru: {
    spent: "💸 Расход",
    received: "💰 Доход",
    review: "🧠 Как дела?",
    picture: "📊 Картина",
    paidBtn: "✓ Оплачено ",
    skipBtn: "Пропустить",
    confirmReceipt: "✓ Записать",
    editReceipt: "✏ Исправить",
    cancelReceipt: "✗ Отмена",
    receiptReading: "_читаю чек…_",
    receiptRead: "📄 Я прочитал: *DESC* — AMT\n\nЗаписать?",
    receiptLogged: "✓ Записано *DESC* — AMT",
    receiptCancelled: "Отменено. Можете ввести вручную.",
    receiptFailed: "Не удалось прочитать. Введите вручную.",
    receiptEdit: "Что правильно? Например: _\"кофе $4.50\"_",
    spentPrompt: "Что потратили? Просто напишите — _\"обед $12\"_ или _\"такси $23\"_\n\nИли сфоткайте чек 📸",
    receivedPrompt: "Что поступило? — _\"зарплата $3,200\"_ или _\"друг вернул $50\"_",
    notSetup: "Ещё не настроено. Отправьте баланс и дату зарплаты.",
    setupFirst: "Сначала настройтесь. Отправьте баланс и дату зарплаты.",
    setupFirstReview: "Сначала настройтесь и запишите несколько расходов — тогда скажу.",
    error: "Что-то пошло не так. Попробуйте ещё.",
    welcome: "Привет — я SpendYes.\n\nЯ не слежу за бюджетом и не читаю нотации. Я показываю сколько ты *можешь* тратить свободно.\n\nДля начала скажите:\n• Сколько сейчас на счёту?\n• Когда следующая зарплата?\n\nПишите как другу.",
    billsPrompt: "Теперь — есть регулярные платежи? Аренда, подписки, спортзал?\n\nПросто напишите или *пропустить*.",
    nudge3: "\n\n_Совет: можете спросить что угодно — \"могу ли я пойти в ресторан?\", \"куда уходят деньги?\" Или сфоткайте чек 📸_",
    nudge5: "\n\n_Попробуйте \"как дела?\" или \"что я потратил за неделю?\" Я вижу паттерны._",
    balance: "Баланс",
    bills: "Счета",
    planned: "Планы",
    pools: "Категории",
    free: "Свободно",
    freeToday: "Сегодня",
    dailyPace: "Темп/день",
    payday: "Зарплата",
    due: "к оплате",
    days: "д",
    daysWord: "дн.",
    paidConfirm: "✓ *NAME* оплачено.",
    skippedConfirm: "*NAME* пропущено — дата сдвинута.",
    resetConfirm: "Всё сброшено. Начнём заново.\n\nСкажите баланс и когда следующая зарплата.",
    resetFail: "Не удалось сбросить. Попробуйте ещё.",
  }
};

function t(lang, key) { return (S[lang] || S.en)[key] || S.en[key] || key; }

function detectLang(ctx) {
  const lc = ctx.from?.language_code || "";
  if (lc.startsWith("ru")) return "ru";
  return "en";
}

// -- KEYBOARDS
function mainKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, "spent"), "quick_spent")
    .text(t(lang, "received"), "quick_received")
    .row()
    .text(t(lang, "review"), "review")
    .row()
    .text(t(lang, "picture"), "show_picture");
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

// -- FORMATTING
function formatPicture(pic, lang) {
  if (!pic.setup) return t(lang, "notSetup");
  const f = (c) => fmt(c).padStart(8);
  const L = (label, w) => (label + " ".repeat(Math.max(1, w - label.length))).slice(0, w);
  const lines = ["```"];
  lines.push(L(t(lang, "balance"), 11) + f(pic.balanceCents));
  lines.push("─".repeat(25));

  // Bill breakdown
  if (pic.drains.length) {
    lines.push(t(lang, "bills") + "    − " + f(pic.billsReservedCents));
    for (const d of pic.drains) {
      const daysStr = d.daysUntilNext != null ? " " + d.daysUntilNext + t(lang, "days") : "";
      const dueMarker = d.isDue ? " !" : "";
      lines.push("  " + d.name.slice(0, 10).padEnd(10) + " " + fmt(d.amountCents || 0).padStart(6) + daysStr + dueMarker);
    }
  } else {
    lines.push(L(t(lang, "bills"), 11) + "− " + f(0));
  }

  // Planned breakdown
  const activePlanned = pic.plannedPurchases.filter(p => !p.confirmed);
  if (activePlanned.length) {
    lines.push(L(t(lang, "planned"), 11) + "− " + f(pic.plannedTotalCents));
    for (const p of activePlanned) {
      const dateStr = p.date ? " " + p.date.slice(5) : "";
      lines.push("  " + p.name.slice(0, 10).padEnd(10) + " " + fmt(p.amountCents || 0).padStart(6) + dateStr);
    }
  } else {
    lines.push(L(t(lang, "planned"), 11) + "− " + f(pic.plannedTotalCents));
  }

  lines.push(L(t(lang, "pools"), 11) + "− " + f(pic.poolReserveCents));
  lines.push("─".repeat(25));
  lines.push(L(t(lang, "free"), 11) + f(pic.trulyFreeCents));
  lines.push(L(t(lang, "freeToday"), 11) + f(pic.freeRemainingTodayCents));
  lines.push(L(t(lang, "dailyPace"), 11) + f(pic.dailyFreePaceCents));
  lines.push("─".repeat(25));
  lines.push(L(t(lang, "payday"), 11) + (pic.payday || "?") + "  " + pic.daysLeft + t(lang, "days"));
  lines.push("```");

  // Due bills warning
  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    lines.push("");
    for (const b of dueBills) {
      lines.push("⚠ *" + b.name + "* " + t(lang, "due") + " — " + fmt(b.amountCents || 0));
    }
  }
  return lines.join("\n");
}

function formatActionReply(pic, lang) {
  const lines = ["```"];
  lines.push(t(lang, "freeToday").padEnd(14) + fmt(pic.freeRemainingTodayCents));
  lines.push(t(lang, "dailyPace").padEnd(14) + fmt(pic.dailyFreePaceCents));
  lines.push(t(lang, "payday").padEnd(14) + pic.daysLeft + " " + t(lang, "daysWord"));
  lines.push("```");
  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    const bill = dueBills[0];
    lines.push("\n⚠ *" + bill.name + "* " + t(lang, "due") + " — " + fmt(bill.amountCents || 0));
  }
  if (pic.freeRemainingTodayCents < 200 && pic.trulyFreeCents > 0) {
    lines.push("\n" + t(lang, "free") + ": " + fmt(pic.trulyFreeCents) + " / " + pic.daysLeft + " " + t(lang, "daysWord"));
  } else if (pic.trulyFreeCents < 0) {
    lines.push("\n⚠");
  }
  return lines.join("\n");
}

function formatMorningBriefing(pic, lang) {
  const lines = [];
  if (pic.trulyFreeCents < 0) lines.push(lang === "ru" ? "Утро. Счета превышают баланс." : "Morning. Bills exceed your balance.");
  else if (pic.freeRemainingTodayCents < 500) lines.push(lang === "ru" ? "Утро. Немного туго." : "Morning. Tight day.");
  else lines.push(lang === "ru" ? "Утро." : "Morning.");
  lines.push("");
  lines.push("```");
  lines.push(t(lang, "freeToday").padEnd(14) + fmt(pic.freeRemainingTodayCents));
  lines.push(t(lang, "dailyPace").padEnd(14) + fmt(pic.dailyFreePaceCents));
  lines.push(t(lang, "payday").padEnd(14) + (pic.daysLeft === 0 ? (lang === "ru" ? "сегодня" : "today") : pic.daysLeft + " " + t(lang, "daysWord")));
  lines.push("```");
  return lines.join("\n");
}

function formatBillAlert(drain, pic, lang) {
  const days = daysUntil(drain.nextDate);
  const when = days <= 0
    ? (lang === "ru" ? "к оплате сегодня" : "due today")
    : (lang === "ru" ? "к оплате завтра" : "due tomorrow");
  return "⚠ *" + drain.name + "* " + when + "\n\n```\n" + fmt(drain.amountCents) + "\n```";
}

// -- CALL SPENDYES (Sonnet, JSON format)
async function callSpendYes(state, userMessage) {
  const history = (state.conversationHistory || []).slice(-20);
  history.push({ role: "user", content: userMessage });
  const langNote = state.language === "ru" ? "\n\nIMPORTANT: The user speaks Russian. Respond in Russian. All message text must be in Russian." : "";
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: v2.buildSystemPrompt(state) + langNote,
    messages: history,
  });
  const text = response.content?.[0]?.text ?? "";
  let parsed;
  const jm = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jm) { parsed = JSON.parse(jm[1]); }
  else { try { parsed = JSON.parse(text); } catch { parsed = { message: text, actions: [{ type: "none" }] }; } }
  return { text, parsed };
}

// -- CALL REVIEW
async function callReview(state) {
  const pic = v2.computePicture(state);
  const lang = state.language || "en";
  const recentTx = state.transactions.slice(-15).map(t =>
    t.date + " | " + t.type + " | " + v2.toUSD(t.amountCents) + " | " + (t.description || t.node || "")
  ).join("\n");
  const drainsList = Object.values(state.drains).filter(d => d.active).map(d =>
    d.name + ": " + v2.toUSD(d.amountCents) + " every " + d.intervalDays + "d, next: " + (d.nextDate || "?")
  ).join("\n");
  const poolsList = Object.values(state.pools).filter(p => p.active).map(p =>
    p.name + ": spent " + v2.toUSD(p.spentCents)
  ).join("\n");

  const langInstr = lang === "ru" ? "Respond entirely in Russian." : "Respond in English.";
  const prompt = `You are SpendYes. The user tapped "How'm I doing?" ${langInstr}

NUMBERS: Balance ${v2.toUSD(state.balanceCents)}, Free ${v2.toUSD(pic.trulyFreeCents)}, Free today ${v2.toUSD(pic.freeRemainingTodayCents)}, Pace ${v2.toUSD(pic.dailyFreePaceCents)}/day, ${pic.daysLeft} days to payday, Savings ${v2.toUSD(state.savingsCents)}
${pic.cycleStats ? "Cycle: spent " + v2.toUSD(pic.cycleStats.totalSpent) + ", avg " + v2.toUSD(pic.cycleStats.dailyAvg) + "/day" : ""}
BILLS: ${drainsList || "none"}
POOLS: ${poolsList || "none"}
RECENT: ${recentTx || "none yet"}

Write a short personal check-in (3-6 sentences). Be a sharp friend who's great with money. Notice patterns, be honest, end forward-looking. No bullets, no headers, no "Great news!" Under 120 words.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system: prompt,
    messages: [{ role: "user", content: lang === "ru" ? "Как дела?" : "How'm I doing?" }],
  });
  return response.content?.[0]?.text ?? "...";
}

// -- GET USER + STATE
async function getUserAndState(telegramId) {
  let user = await prisma.user.findUnique({ where: { telegramId: String(telegramId) } });
  if (!user) user = await prisma.user.create({ data: { telegramId: String(telegramId) } });
  const state = await db.loadState(prisma, user.id);
  return { user, state };
}

// -- DETECT + SAVE LANGUAGE
async function ensureLanguage(ctx, user, state) {
  const detected = detectLang(ctx);
  if (state.language !== detected && !state.setup) {
    state.language = detected;
    await prisma.user.update({ where: { id: user.id }, data: { language: detected } });
  }
  return state.language || "en";
}

// -- NUDGE
function maybeNudge(txCount, lang) {
  if (txCount === 3) return t(lang, "nudge3");
  if (txCount === 5) return t(lang, "nudge5");
  return "";
}

// -- PROCESS MESSAGE
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
      // Full DB wipe for AI-triggered reset
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
    const hasSetup = parsed.actions?.some(a => a.type === "setup");
    const hasTx = parsed.actions?.some(a => a.type === "transaction" || a.type === "income" || a.type === "confirm_payment" || a.type === "confirm_planned");
    const nudge = hasTx ? maybeNudge(newState.transactions.length, lang) : "";
    if (hasSetup || hasTx) {
      const msg = (parsed.message || "Got it.") + "\n\n" + formatActionReply(pic, lang) + nudge;
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      if (hasSetup && !state.setup) {
        const bp = t(lang, "billsPrompt");
        setTimeout(() => ctx.reply(bp, { parse_mode: "Markdown" }), 800);
      }
    } else {
      await ctx.reply(parsed.message || "Got it.", { parse_mode: "Markdown", reply_markup: newState.setup ? mainKeyboard(lang) : undefined });
    }
  });
}

// -- MESSAGE HANDLER
if (bot) bot.on("message:text", async (ctx) => {
  try {
    await processMessage(ctx, ctx.from.id, ctx.message.text);
  } catch (err) {
    console.error("Message handler error:", err);
    await ctx.reply(t(detectLang(ctx), "error"));
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
    if (!transcription.text) { await ctx.reply("Couldn't catch that."); return; }
    await processMessage(ctx, ctx.from.id, transcription.text);
  } catch (err) {
    console.error("Voice handler error:", err);
    await ctx.reply("Couldn't process that voice message.");
  }
});

// -- PHOTO / RECEIPT HANDLER (with confirmation)
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
          { type: "text", text: 'Extract the total amount and a short description from this receipt. Reply with JSON: {"description": "...", "amountUSD": number}. If there\'s a foreign currency amount, include "localAmount" and "currency" fields too.' }
        ]
      }],
    });
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
    // Store pending receipt and ask for confirmation
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
    const lang = detectLang(ctx);
    await ctx.reply(t(lang, "receiptFailed"));
  }
});

// -- /start COMMAND
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
          ? "С возвращением. Просто пиши что тратишь, или сфоткай чек 📸"
          : "Welcome back. Just tell me what you spend, or snap a receipt 📸";
      } else if (pic.trulyFreeCents < 0) {
        greeting = lang === "ru"
          ? "Туго сейчас — счета превышают баланс. Нажми *Как дела?*"
          : "Hey. Things are tight. Tap *How'm I doing?* for the full picture.";
      } else if (pic.daysLeft <= 3) {
        greeting = (lang === "ru"
          ? "Почти зарплата. Сегодня свободно "
          : "Almost payday. Free today: ") + fmt(pic.freeRemainingTodayCents);
      } else {
        greeting = fmt(pic.freeRemainingTodayCents) + (lang === "ru"
          ? " сегодня, " + fmt(pic.dailyFreePaceCents) + "/день, " + pic.daysLeft + " дн. до зп."
          : " free today, " + fmt(pic.dailyFreePaceCents) + "/day, " + pic.daysLeft + " days to payday.");
      }
      await ctx.reply(greeting + "\n\n" + formatPicture(pic, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
    } else {
      await ctx.reply(t(lang, "welcome"), { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Start error:", err);
  }
});

// -- /reset COMMAND
if (bot) bot.command("reset", async (ctx) => {
  try {
    const telegramId = String(ctx.from.id);
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      const lang = detectLang(ctx);
      await ctx.reply(t(lang, "resetConfirm"));
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

// -- CALLBACK QUERIES
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
      await ctx.reply(reviewText, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data === "show_picture") {
      const pic = v2.computePicture(state);
      await ctx.reply(formatPicture(pic, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }

    // -- Receipt confirmation
    if (data === "receipt_confirm") {
      const receipt = pendingReceipts.get(String(ctx.from.id));
      if (!receipt) { await ctx.reply("No pending receipt."); return; }
      pendingReceipts.delete(String(ctx.from.id));
      await db.withUserLock(user.id, async () => {
        const freshState = await db.loadState(prisma, user.id);
        let newState = v2.applyAction(freshState, {
          type: "transaction", data: { description: receipt.description, amountUSD: receipt.amountUSD }
        });
        await db.saveState(prisma, user.id, newState);
        const pic = v2.computePicture(newState);
        const nudge = maybeNudge(newState.transactions.length, lang);
        const msg = t(lang, "receiptLogged")
          .replace("DESC", receipt.description)
          .replace("AMT", fmt(v2.toCents(receipt.amountUSD)));
        await ctx.editMessageText(msg + "\n\n" + formatActionReply(pic, lang) + nudge, {
          parse_mode: "Markdown", reply_markup: mainKeyboard(lang)
        });
      });
      return;
    }
    if (data === "receipt_edit") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(t(lang, "receiptEdit"), { parse_mode: "Markdown" });
      return;
    }
    if (data === "receipt_cancel") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(t(lang, "receiptCancelled"), { parse_mode: "Markdown" });
      return;
    }

    // -- Bill paid/skip
    if (data.startsWith("paid:")) {
      const billName = data.slice(5);
      await db.withUserLock(user.id, async () => {
        const freshState = await db.loadState(prisma, user.id);
        let newState = v2.applyAction(freshState, { type: "confirm_payment", data: { name: billName } });
        await db.saveState(prisma, user.id, newState);
        const newPic = v2.computePicture(newState);
        await ctx.editMessageText(
          t(lang, "paidConfirm").replace("NAME", billName) + "\n\n" + formatActionReply(newPic, lang),
          { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) }
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
          t(lang, "skippedConfirm").replace("NAME", billName) + "\n\n" + formatActionReply(newPic, lang),
          { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) }
        );
      });
      return;
    }
  } catch (err) {
    console.error("Callback handler error:", err);
  }
});

// -- PROACTIVE
async function sendMorningBriefing(telegramId) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(telegramId);
    if (!state.setup) return;
    const lang = state.language || "en";
    const pic = v2.computePicture(state);
    await bot.api.sendMessage(telegramId, formatMorningBriefing(pic, lang), {
      parse_mode: "Markdown", reply_markup: mainKeyboard(lang),
    });
  } catch (err) { console.error("Morning briefing error:", err); }
}

async function sendBillAlert(telegramId, billName) {
  if (!bot) return;
  try {
    const { state } = await getUserAndState(telegramId);
    if (!state.setup) return;
    const lang = state.language || "en";
    const key = billName.toLowerCase().trim();
    const drain = state.drains[key];
    if (!drain) return;
    const pic = v2.computePicture(state);
    await bot.api.sendMessage(telegramId, formatBillAlert(drain, pic, lang), {
      parse_mode: "Markdown", reply_markup: billActionKeyboard(lang, billName),
    });
  } catch (err) { console.error("Bill alert error:", err); }
}

module.exports = { bot, sendMorningBriefing, sendBillAlert };
