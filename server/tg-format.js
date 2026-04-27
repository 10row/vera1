"use strict";
// tg-format.js — Language strings + Telegram formatting functions

const v2 = require("./vera-v2");

// ── UTILS ──────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }

function daysUntil(ds) {
  if (!ds) return 99;
  return Math.ceil((new Date(ds + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000);
}

function fmt(cents) {
  if (cents == null) return "$0";
  const neg = cents < 0, abs = Math.abs(cents);
  return (neg ? "-" : "") + "$" + Math.floor(abs / 100).toLocaleString();
}

// ── LANGUAGE STRINGS ───────────────────────────
const S = {
  en: {
    // Buttons
    spent: "\u{1F4B8} Spent",
    received: "\u{1F4B0} Received",
    review: "\u{1F9E0} How'm I doing?",
    picture: "\u{1F4CA} My Picture",
    feedWeek: "This Week",
    feedMonth: "This Month",
    paidBtn: "✓ Paid ",
    skipBtn: "Skip",
    confirmReceipt: "✓ Log it",
    editReceipt: "✏ Edit",
    cancelReceipt: "✗ Cancel",

    // Receipt flow
    receiptReading: "_Reading your receipt..._",
    receiptRead: "\u{1F4C4} I read: *DESC* — AMT\n\nShould I log this?",
    receiptLogged: "✓ Logged *DESC* — AMT",
    receiptCancelled: "Cancelled. You can type it manually if you'd like.",
    receiptFailed: "Couldn't read that receipt. Try typing it instead — e.g. \"lunch $12\".",
    receiptEdit: "No problem — what's the correct amount?",

    // Prompts
    spentPrompt: "What did you spend? Type something like _\"lunch $12\"_ or snap a receipt \u{1F4F8}",
    receivedPrompt: "What came in? _\"got paid $3,200\"_",
    notSetup: "I'm not set up yet. Tell me your current bank balance to get started!",
    setupFirst: "Let's get you set up first — what's your current bank balance?",
    setupFirstReview: "I need to be set up before I can review your spending. Tell me your balance to start!",

    // Errors
    error: "Something went wrong — try sending that again.",
    resetFail: "Couldn't reset. Please try again.",

    // Welcome & onboarding
    welcome: "Hey — I'm SpendYes! \u{1F44B}\n\nI show you what you *can* spend freely, so you never have to wonder.\n\nWhat's your current bank balance?",
    billsPrompt: "Great! Now, any regular bills? Rent, subscriptions, gym?\n\nJust tell me about them, or say *skip* to move on.",
    resetConfirm: "Everything's been wiped clean. Let's start fresh!\n\nWhat's your current bank balance?",

    // Nudges
    nudge3: "\n\n_Tip: you can ask me anything about your spending, or snap a receipt \u{1F4F8}_",
    nudge5: "\n\n_Try tapping \"How'm I doing?\" — I'll give you the real picture._",

    // Dashboard labels
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
    payday: "Payday",
    due: "due",
    days: "d",
    daysWord: "days",

    // Confirmations
    paidConfirm: "✓ *NAME* paid. Nice one!",
    skippedConfirm: "Skipped *NAME* — I've moved the next date forward.",
  },

  ru: {
    // Buttons
    spent: "\u{1F4B8} Расход",
    received: "\u{1F4B0} Доход",
    review: "\u{1F9E0} Как дела?",
    picture: "\u{1F4CA} Картина",
    feedWeek: "Эта неделя",
    feedMonth: "Этот месяц",
    paidBtn: "✓ Оплачено ",
    skipBtn: "Пропустить",
    confirmReceipt: "✓ Записать",
    editReceipt: "✏ Исправить",
    cancelReceipt: "✗ Отмена",

    // Receipt flow
    receiptReading: "_Читаю чек…_",
    receiptRead: "\u{1F4C4} Я прочитал: *DESC* — AMT\n\nЗаписать?",
    receiptLogged: "✓ Записано *DESC* — AMT",
    receiptCancelled: "Отменено. Можете ввести вручную.",
    receiptFailed: "Не смог прочитать. Напишите сами, например \"обед $12\".",
    receiptEdit: "Какая правильная сумма?",

    // Prompts
    spentPrompt: "Что потратили? Например _\"обед $12\"_ или сфоткайте чек \u{1F4F8}",
    receivedPrompt: "Что поступило? _\"зарплата $3,200\"_",
    notSetup: "Я ещё не настроен. Скажите свой текущий баланс!",
    setupFirst: "Давайте сначала настроимся — сколько сейчас на счёту?",
    setupFirstReview: "Сначала настройтесь, и я смогу показать картину.",

    // Errors
    error: "Что-то пошло не так. Попробуйте ещё раз.",
    resetFail: "Не удалось сбросить. Попробуйте ещё.",

    // Welcome & onboarding
    welcome: "Привет — я SpendYes! \u{1F44B}\n\nПоказываю сколько *можешь* тратить свободно.\n\nСколько сейчас на счёту?",
    billsPrompt: "Есть регулярные платежи? Аренда, подписки, спортзал?\n\nНапишите или *пропустить*.",
    resetConfirm: "Всё сброшено. Начнём заново!\n\nСколько сейчас на счёту?",

    // Nudges
    nudge3: "\n\n_Совет: спросите что угодно или сфоткайте чек \u{1F4F8}_",
    nudge5: "\n\n_Попробуйте \"Как дела?\" — я вижу паттерны._",

    // Dashboard labels
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
    feedWeekLabel: "Эта неделя",
    feedMonthLabel: "Этот месяц",
    payday: "Зарплата",
    due: "к оплате",
    days: "д",
    daysWord: "дн.",

    // Confirmations
    paidConfirm: "✓ *NAME* оплачено.",
    skippedConfirm: "*NAME* пропущено — дата сдвинута.",
  }
};

function t(lang, key) { return (S[lang] || S.en)[key] || S.en[key] || key; }

function detectLang(ctx) {
  const lc = ctx.from?.language_code || "";
  return lc.startsWith("ru") ? "ru" : "en";
}

// ── FORMATTING ─────────────────────────────────
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

  // Due bills
  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    lines.push("");
    for (const b of dueBills) lines.push("⚠ *" + b.name + "* " + t(lang, "due") + " — " + fmt(b.amountCents || 0));
  }

  // Upcoming bills
  const ub = (pic.upcomingBills || []).filter(b => !dueBills.some(d => d.name === b.name));
  if (ub.length) {
    lines.push("");
    lines.push(t(lang, "upcoming") + ":");
    for (const b of ub) lines.push("  " + b.name + " " + b.amt + " (" + b.days + t(lang, "days") + ")");
  }

  // Recent transactions
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
  if (pic.trulyFreeCents < 0) lines.push(lang === "ru" ? "Утро. Перерасход." : "Morning. You're over budget.");
  else if (pic.freeRemainingTodayCents < 500) lines.push(lang === "ru" ? "Утро. Туго сегодня." : "Morning. It's tight today.");
  else lines.push(lang === "ru" ? "Доброе утро!" : "Good morning!");
  lines.push("");
  lines.push("```");
  lines.push(t(lang, "freeToday").padEnd(14) + fmt(pic.freeRemainingTodayCents));
  lines.push(t(lang, "dailyPace").padEnd(14) + fmt(pic.dailyFreePaceCents));
  lines.push(t(lang, "payday").padEnd(14) + (pic.daysLeft === 0
    ? (lang === "ru" ? "сегодня" : "today")
    : pic.daysLeft + " " + t(lang, "daysWord")));
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
  const w = period === "week", L = [];
  L.push("*" + t(lang, w ? "feedWeek" : "feedMonth") + "*", "```");
  L.push((w ? t(lang, "thisWeek") : t(lang, "feedMonth")).padEnd(14) + fmt(w ? pic.thisWeekSpentCents : pic.thisMonthSpentCents));
  if (w) L.push(t(lang, "weeklyPace").padEnd(14) + fmt(pic.weeklyFreePaceCents));
  L.push(t(lang, "dailyPace").padEnd(14) + fmt(pic.dailyFreePaceCents), "```");
  const cd = new Date(); cd.setDate(cd.getDate() - (w ? 7 : 30));
  const cs = cd.toISOString().slice(0, 10);
  const txs = (state.transactions || [])
    .filter(tx => tx.date >= cs && (tx.type === "transaction" || tx.type === "refund"))
    .slice(-10).reverse();
  if (txs.length) {
    L.push("");
    for (const tx of txs) {
      L.push((tx.date || "").slice(5) + " " + (tx.description || "").slice(0, 14).padEnd(14) + " " + fmt(tx.amountCents));
    }
  }
  return L.join("\n");
}

module.exports = {
  S, t, detectLang, fmt, daysUntil, today,
  formatPicture, formatActionReply,
  formatMorningBriefing, formatBillAlert, formatSpendFeed,
};
