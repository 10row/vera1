"use strict";

// telegram.js - SpendYes v2 Bot

const Anthropic = require("@anthropic-ai/sdk").default;
const OpenAI = require("openai");
const { Bot, InlineKeyboard } = require("grammy");
const prisma = require("./db/client");
const db = require("./db/queries");
const v2 = require("./vera-v2");
const { responseSchema } = require("./openai-schema");

const anthropic = new Anthropic();
const openai = new OpenAI();
const bot = process.env.BOT_TOKEN ? new Bot(process.env.BOT_TOKEN) : null;

// -- PENDING RECEIPTS
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
    receiptReading: "_reading…_",
    receiptRead: "📄 I read: *DESC* — AMT\n\nLog this?",
    receiptLogged: "✓ Logged *DESC* — AMT",
    receiptCancelled: "Cancelled. Type it manually.",
    receiptFailed: "Couldn't read. Type manually.",
    receiptEdit: "What's the right amount?",
    spentPrompt: "What did you spend? _\"lunch $12\"_",
    receivedPrompt: "What came in? _\"got paid $3,200\"_",
    notSetup: "Not set up yet. Tell me your balance to get started.",
    setupFirst: "Set up first — tell me your balance.",
    setupFirstReview: "Set up first, then I'll have data.",
    error: "Something went wrong. Try again.",
    welcome: "Hey — I'm SpendYes. I show what you *can* spend freely.\n\nWhat's your bank balance?",
    billsPrompt: "Any regular bills? Rent, subscriptions, gym?\n\nJust tell me or say *skip*.",
    nudge3: "\n\n_Tip: ask anything or snap a receipt 📸_",
    nudge5: "\n\n_Try \"how'm I doing?\"_",
    balance: "Balance",
    bills: "Bills",
    planned: "Planned",
    pools: "Pools",
    free: "Free",
    freeToday: "Free today",
    dailyPace: "Daily pace",
    weeklyPace: "Weekly pace",
    thisWeek: "This week",
    recent: "Recent",
    upcoming: "Coming up",
    feedWeek: "This Week",
    feedMonth: "This Month",
    payday: "Payday",
    due: "due",
    days: "d",
    daysWord: "days",
    paidConfirm: "✓ *NAME* paid.",
    skippedConfirm: "Skipped *NAME* — next date advanced.",
    resetConfirm: "Everything wiped. Let's start fresh!\n\nWhat's your current bank balance?",
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
    receiptReading: "_читаю…_",
    receiptRead: "📄 Я прочитал: *DESC* — AMT\n\nЗаписать?",
    receiptLogged: "✓ Записано *DESC* — AMT",
    receiptCancelled: "Отменено. Введите вручную.",
    receiptFailed: "Не прочитал. Введите сами.",
    receiptEdit: "Правильная сумма?",
    spentPrompt: "Что потратили? _\"обед $12\"_ или чек 📸",
    receivedPrompt: "Что поступило? _\"зарплата $3,200\"_",
    notSetup: "Не настроено. Скажите баланс.",
    setupFirst: "Сначала настройтесь — скажите баланс.",
    setupFirstReview: "Сначала настройтесь.",
    error: "Что-то пошло не так. Попробуйте ещё.",
    welcome: "Привет — я SpendYes.\n\nПоказываю сколько *можешь* тратить свободно.\n\nСколько сейчас на счёту?",
    billsPrompt: "Есть регулярные платежи? Аренда, подписки?\n\nНапишите или *пропустить*.",
    nudge3: "\n\n_Совет: спросите что угодно или сфоткайте чек 📸_",
    nudge5: "\n\n_Попробуйте \"как дела?\" — я вижу паттерны._",
    balance: "Баланс",
    bills: "Счета",
    planned: "Планы",
    pools: "Категории",
    free: "Свободно",
    freeToday: "Сегодня",
    dailyPace: "Темп/день",
    weeklyPace: "Темп/нед",
    thisWeek: "За неделю",
    recent: "Последние",
    upcoming: "Скоро",
    feedWeek: "Эта неделя",
    feedMonth: "Этот месяц",
    payday: "Зарплата",
    due: "к оплате",
    days: "д",
    daysWord: "дн.",
    paidConfirm: "✓ *NAME* оплачено.",
    skippedConfirm: "*NAME* пропущено — дата сдвинута.",
    resetConfirm: "Всё сброшено. Начнём заново!\n\nСколько сейчас на счёту?",
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
  lines.push(L(t(lang, "weeklyPace"), 11) + f(pic.weeklyFreePaceCents));
  lines.push(L(t(lang, "thisWeek"), 11) + f(pic.thisWeekSpentCents));
  lines.push("─".repeat(25));
  lines.push(L(t(lang, "payday"), 11) + (pic.payday || "?") + "  " + pic.daysLeft + t(lang, "days"));
  lines.push("```");
  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    lines.push("");
    for (const b of dueBills) lines.push("⚠ *" + b.name + "* " + t(lang, "due") + " — " + fmt(b.amountCents || 0));
  }
  const ub = (pic.upcomingBills || []).filter(b => !dueBills.some(d => d.name === b.name));
  if (ub.length) {
    lines.push("");
    lines.push(t(lang, "upcoming") + ":");
    for (const b of ub) lines.push("  " + b.name + " " + b.amt + " (" + b.days + t(lang, "days") + ")");
  }
  const txs = (pic.transactions || []).slice(0, 5);
  if (txs.length) {
    lines.push("");
    lines.push(t(lang, "recent") + ":");
    for (const tx of txs) lines.push("  " + (tx.description || "").slice(0, 12).padEnd(12) + " " + fmt(tx.amountCents));
  }
  return lines.join("\n");
}

function formatActionReply(pic, lang) {
  const lines = ["```"];
  lines.push(t(lang, "freeToday").padEnd(14) + fmt(pic.freeRemainingTodayCents));
  lines.push(t(lang, "dailyPace").padEnd(14) + fmt(pic.dailyFreePaceCents));
  lines.push(t(lang, "weeklyPace").padEnd(14) + fmt(pic.weeklyFreePaceCents));
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
  if (pic.trulyFreeCents < 0) lines.push(lang==="ru"?"Утро. Перерасход.":"Morning. Over budget.");
  else if (pic.freeRemainingTodayCents<500) lines.push(lang==="ru"?"Утро. Туго.":"Morning. Tight.");
  else lines.push(lang==="ru"?"Утро.":"Morning.");
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

function formatSpendFeed(pic, state, period, lang) {
  const w = period==="week", L = [];
  L.push("*"+t(lang,w?"feedWeek":"feedMonth")+"*","```");
  L.push((w?t(lang,"thisWeek"):t(lang,"feedMonth")).padEnd(14)+fmt(w?pic.thisWeekSpentCents:pic.thisMonthSpentCents));
  if(w) L.push(t(lang,"weeklyPace").padEnd(14)+fmt(pic.weeklyFreePaceCents));
  L.push(t(lang,"dailyPace").padEnd(14)+fmt(pic.dailyFreePaceCents),"```");
  const cd=new Date(); cd.setDate(cd.getDate()-(w?7:30));
  const cs=cd.toISOString().slice(0,10);
  const txs=(state.transactions||[]).filter(tx=>tx.date>=cs&&(tx.type==="transaction"||tx.type==="refund")).slice(-10).reverse();
  if(txs.length){L.push("");for(const tx of txs)L.push((tx.date||"").slice(5)+" "+(tx.description||"").slice(0,14).padEnd(14)+" "+fmt(tx.amountCents));}
  return L.join("\n");
}

// -- CALL SPENDYES
async function callSpendYes(state, userMessage) {
  const history = (state.conversationHistory || []).slice(-10);
  history.push({ role: "user", content: userMessage });
  const langNote = state.language === "ru" ? "\n\nIMPORTANT: The user speaks Russian. Respond in Russian. All message text must be in Russian." : "";
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1024,
    response_format: { type: "json_schema", json_schema: responseSchema },
    messages: [
      { role: "system", content: v2.buildSystemPrompt(state) + langNote },
      ...history,
    ],
  });
  const text = response.choices?.[0]?.message?.content ?? "";
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { parsed = { message: text, actions: [{ type: "none", data: {} }] }; }
  return { text, parsed };
}

// -- CALL REVIEW
async function callReview(state) {
  const p = v2.computePicture(state), l = state.language || "en";
  const tx = (p.transactions||[]).slice(0,8).map(t=>t.date+"|"+v2.toUSD(t.amountCents)+"|"+(t.description||"")).join("\n");
  const bl = (p.drains||[]).map(d=>d.name+":"+d.amountUSD+(d.daysUntilNext!=null?" "+d.daysUntilNext+"d":"")).join(",");
  const li = l==="ru"?"Respond in Russian.":"";
  const sys = `SpendYes check-in.${li} FACTS(pre-computed,NEVER recalculate):Bal:${p.balanceUSD} Free:${p.trulyFreeUSD} Pace:${p.dailyFreePaceUSD}/d WkPace:${p.weeklyFreePaceUSD} Today:${p.todaySpentUSD} FreeToday:${p.freeRemainingTodayUSD} WkSpent:${p.thisWeekSpentUSD} MoSpent:${p.thisMonthSpentUSD} AvgTx:${p.avgTransactionUSD} ${p.daysLeft}d left Day${p.dayOfCycle}/${p.daysInCycle} Cycle:${p.cycleStats?p.cycleStats.totalSpentUSD:"$0"} avg${p.cycleStats?p.cycleStats.dailyAvgUSD:"$0"}/d Bills:${bl||"none"}\nRecent:\n${tx||"none"}\nONLY quote numbers above.NEVER arithmetic.3-6 sentences.Sharp money friend.Honest.<100w`;
  const r = await openai.chat.completions.create({model:"gpt-4o-mini",max_tokens:300,messages:[{role:"system",content:sys},{role:"user",content:l==="ru"?"\u041a\u0430\u043a \u0434\u0435\u043b\u0430?":"How'm I doing?"}]});
  return r.choices?.[0]?.message?.content ?? "...";
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
    const hasTx = parsed.actions?.some(a => a.type === "transaction" || a.type === "income" || a.type === "confirm_payment" || a.type === "confirm_planned");
    const justSetUp = !state.setup && newState.setup;
    const nudge = hasTx ? maybeNudge(newState.transactions.length, lang) : "";
    if (newState.setup && (justSetUp || hasTx)) {
      const msg = (parsed.message || "Got it.") + "\n\n" + formatActionReply(pic, lang) + nudge;
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
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
      await ctx.reply(t(lang,"spentPrompt"),{parse_mode:"Markdown"});
      return;
    }
    if (data === "quick_received") {
      await ctx.reply(t(lang,"receivedPrompt"),{parse_mode:"Markdown"});
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
      await ctx.reply(formatSpendFeed(pic, state, period, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }
    if (data === "show_picture") {
      const pic = v2.computePicture(state);
      await ctx.reply(formatPicture(pic, lang), { parse_mode: "Markdown", reply_markup: mainKeyboard(lang) });
      return;
    }

    // -- Receipt confirmation
    if (data==="receipt_confirm") {
      const rc=pendingReceipts.get(String(ctx.from.id));
      if(!rc){await ctx.reply("No pending receipt.");return;}
      pendingReceipts.delete(String(ctx.from.id));
      await db.withUserLock(user.id,async()=>{const fs=await db.loadState(prisma,user.id);
      let ns=v2.applyAction(fs,{type:"transaction",data:{description:rc.description,amountUSD:rc.amountUSD}});
      await db.saveState(prisma,user.id,ns);const p=v2.computePicture(ns);
      const msg=t(lang,"receiptLogged").replace("DESC",rc.description).replace("AMT",fmt(v2.toCents(rc.amountUSD)));
      await ctx.editMessageText(msg+"\n\n"+formatActionReply(p,lang)+maybeNudge(ns.transactions.length,lang),{parse_mode:"Markdown",reply_markup:mainKeyboard(lang)});
      });return;
    }
    if (data==="receipt_edit"||data==="receipt_cancel") {
      pendingReceipts.delete(String(ctx.from.id));
      await ctx.editMessageText(t(lang,data==="receipt_edit"?"receiptEdit":"receiptCancelled"),{parse_mode:"Markdown"});
      return;
    }

    // -- Bill paid/skip
    if (data.startsWith("paid:")||data.startsWith("skip:")) {
      const isPaid=data.startsWith("paid:"),bn=data.slice(isPaid?5:5);
      await db.withUserLock(user.id,async()=>{const fs=await db.loadState(prisma,user.id);
      const ns=v2.applyAction(fs,{type:isPaid?"confirm_payment":"skip_payment",data:{name:bn}});
      await db.saveState(prisma,user.id,ns);const np=v2.computePicture(ns);
      await ctx.editMessageText(t(lang,isPaid?"paidConfirm":"skippedConfirm").replace("NAME",bn)+"\n\n"+formatActionReply(np,lang),{parse_mode:"Markdown",reply_markup:mainKeyboard(lang)});
      });return;
    }
  } catch (err) {
    console.error("Callback handler error:", err);
  }
});

// -- PROACTIVE
async function sendMorningBriefing(tid) {
  if(!bot)return;
  try{const{state}=await getUserAndState(tid);if(!state.setup)return;
  const l=state.language||"en",p=v2.computePicture(state);
  await bot.api.sendMessage(tid,formatMorningBriefing(p,l),{parse_mode:"Markdown",reply_markup:mainKeyboard(l)});
  }catch(e){console.error("Briefing err:",e);}
}
async function sendBillAlert(tid,bn) {
  if(!bot)return;
  try{const{state}=await getUserAndState(tid);if(!state.setup)return;
  const l=state.language||"en",dr=Object.values(state.drains).find(d=>d.name.toLowerCase()===bn.toLowerCase()&&d.active);
  if(!dr)return;const p=v2.computePicture(state);
  await bot.api.sendMessage(tid,formatBillAlert(dr,p,l),{parse_mode:"Markdown"});
  }catch(e){console.error("Bill alert err:",e);}
}
async function runDailyBriefings() {
  try{const us=await prisma.user.findMany({where:{setup:true,telegramId:{not:null}},select:{telegramId:true}});
  for(const u of us)if(u.telegramId)await sendMorningBriefing(u.telegramId);
  console.log("Briefings:"+us.length);}catch(e){console.error("Briefings err:",e);}
}
async function runBillAlerts() {
  try{const us=await prisma.user.findMany({where:{setup:true,telegramId:{not:null}},select:{id:true,telegramId:true}});
  for(const u of us){const st=await db.loadState(prisma,u.id),p=v2.computePicture(st);
  for(const b of(p.upcomingBills||[]))if(b.days<=1)await sendBillAlert(u.telegramId,b.name);
  }}catch(e){console.error("Bill alerts err:",e);}
}
module.exports={bot,sendMorningBriefing,sendBillAlert,runDailyBriefings,runBillAlerts};
