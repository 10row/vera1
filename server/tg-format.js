"use strict";
// tg-format.js — Language strings + Telegram formatting functions

const v2 = require("./vera-v2");

// ── UTILS ──────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }

function daysUntil(ds) {
  if (!ds) return 99;
  return Math.ceil((new Date(ds + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000);
}

function fmt(cents, sym) {
  const s = sym || "$";
  if (cents == null) return s + "0";
  const neg = cents < 0, abs = Math.abs(cents);
  return (neg ? "-" : "") + s + Math.floor(abs / 100).toLocaleString();
}

// ── LANGUAGE STRINGS ───────────────────────────
const S = {
  en: {
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
    receiptReading: "_Reading your receipt..._",
    receiptRead: "\u{1F4C4} I read: *DESC* — AMT\n\nShould I log this?",
    receiptLogged: "✓ Logged *DESC* — AMT",
    receiptCancelled: "Cancelled. You can type it manually if you'd like.",
    receiptFailed: "Couldn't read that receipt. Try typing it instead — e.g. \"lunch $12\".",
    receiptEdit: "No problem — what's the correct amount?",
    spentPrompt: "What did you spend? Type something like _\"lunch $12\"_ or snap a receipt \u{1F4F8}",
    receivedPrompt: "What came in? _\"got paid $3,200\"_",
    notSetup: "I'm not set up yet. Tell me your current bank balance to get started!",
    setupFirst: "Let's get you set up first — what's your current bank balance?",
    setupFirstReview: "I need to be set up before I can review your spending. Tell me your balance to start!",
    error: "Something went wrong — try sending that again.",
    resetFail: "Couldn't reset. Please try again.",
    welcome: "Hey — I'm SpendYes! \u{1F44B}\n\nI show you what you *can* spend freely, so you never have to wonder.\n\nWhat's your current bank balance?",
    billsPrompt: "Great! Now, any regular bills? Rent, subscriptions, gym?\n\nJust tell me about them, or say *skip* to move on.",
    resetConfirm: "Everything's been wiped clean. Let's start fresh!\n\nWhat's your current bank balance?",
    nudge3: "\n\n_Tip: you can ask me anything about your spending, or snap a receipt \u{1F4F8}_",
    nudge5: "\n\n_Try tapping \"How'm I doing?\" — I'll give you the real picture._",
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
    savings: "Savings",
    savingRate: "Save rate",
    payday: "Payday",
    due: "due",
    days: "d",
    daysWord: "days",
    paidConfirm: "✓ *NAME* paid. Nice one!",
    skippedConfirm: "Skipped *NAME* — I've moved the next date forward.",
  },
  ru: {
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
    receiptReading: "_Читаю чек…_",
    receiptRead: "\u{1F4C4} Я прочитал: *DESC* — AMT\n\nЗаписать?",
    receiptLogged: "✓ Записано *DESC* — AMT",
    receiptCancelled: "Отменено. Можете ввести вручную.",
    receiptFailed: "Не смог прочитать. Напишите сами, например \"обед $12\".",
    receiptEdit: "Какая правильная сумма?",
    spentPrompt: "Что потратили? Например _\"обед $12\"_ или сфоткайте чек \u{1F4F8}",
    receivedPrompt: "Что поступило? _\"зарплата $3,200\"_",
    notSetup: "Я ещё не настроен. Скажите свой текущий баланс!",
    setupFirst: "Давайте сначала настроимся — сколько сейчас на счёту?",
    setupFirstReview: "Сначала настройтесь, и я смогу показать картину.",
    error: "Что-то пошло не так. Попробуйте ещё раз.",
    resetFail: "Не удалось сбросить. Попробуйте ещё.",
    welcome: "Привет — я SpendYes! \u{1F44B}\n\nПоказываю сколько *можешь* тратить свободно.\n\nСколько сейчас на счёту?",
    billsPrompt: "Есть регулярные платежи? Аренда, подписки, спортзал?\n\nНапишите или *пропустить*.",
    resetConfirm: "Всё сброшено. Начнём заново!\n\nСколько сейчас на счёту?",
    nudge3: "\n\n_Совет: спросите что угодно или сфоткайте чек \u{1F4F8}_",
    nudge5: "\n\n_Попробуйте \"Как дела?\" — я вижу паттерны._",
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
    savings: "Накопления",
    savingRate: "Отложить",
    payday: "Зарплата",
    due: "к оплате",
    days: "д",
    daysWord: "дн.",
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
  const sym = pic.currencySymbol || "$";
  const f = (c) => fmt(c, sym);
  const lines = [];

  // Headline — the number that matters most
  lines.push("*" + t(lang, "freeToday") + ": " + f(pic.freeRemainingTodayCents) + "*");
  lines.push(t(lang, "dailyPace") + " " + f(pic.dailyFreePaceCents) + " · " + pic.daysLeft + " " + t(lang, "daysWord"));
  lines.push("");

  // Waterfall breakdown
  const R = (label, val) => label.padEnd(12) + f(val).padStart(10);
  lines.push("```");
  lines.push(R(t(lang, "balance"), pic.balanceCents));
  if (pic.billsReservedCents > 0) lines.push(R("- " + t(lang, "bills"), pic.billsReservedCents));
  if (pic.plannedTotalCents > 0) lines.push(R("- " + t(lang, "planned"), pic.plannedTotalCents));
  if (pic.poolReserveCents > 0) lines.push(R("- " + t(lang, "pools"), pic.poolReserveCents));
  lines.push("".padEnd(22, "-"));
  lines.push(R(t(lang, "free"), pic.trulyFreeCents));
  lines.push("");
  lines.push(R(t(lang, "weeklyPace"), pic.weeklyFreePaceCents));
  lines.push(R(t(lang, "thisWeek"), pic.thisWeekSpentCents));
  lines.push(t(lang, "payday").padEnd(12) + ((pic.payday || "?").slice(5) + " " + pic.daysLeft + t(lang, "days")).padStart(10));
  if (pic.savingsCents > 0 || pic.savingRateBps > 0) {
    lines.push(R(t(lang, "savings"), pic.savingsCents) + " " + (pic.savingRateBps / 100).toFixed(0) + "%");
  }
  lines.push("```");

  // Due bills — urgent
  const dueBills = pic.drains.filter(d => d.isDue);
  for (const b of dueBills) lines.push("⚠ *" + b.name + "* " + t(lang, "due") + " — " + f(b.amountCents || 0));

  // Upcoming bills
  const ub = (pic.upcomingBills || []).filter(b => !dueBills.some(d => d.name === b.name));
  if (ub.length) {
    lines.push("");
    lines.push(t(lang, "upcoming") + ":");
    for (const b of ub) lines.push("  " + b.name + " " + b.amt + " (" + b.days + t(lang, "days") + ")");
  }

  // Recent spending only — filter out setup, income, correction
  const spendTypes = new Set(["transaction", "refund", "bill_payment"]);
  const txs = (pic.transactions || []).filter(tx => spendTypes.has(tx.type)).slice(0, 5);
  if (txs.length) {
    lines.push("");
    lines.push(t(lang, "recent") + ":");
    for (const tx of txs) {
      const sign = tx.type === "refund" ? "+" : "";
      lines.push("  " + (tx.description || "").slice(0, 12).padEnd(12) + " " + sign + f(tx.amountCents));
    }
  }
  return lines.join("\n");
}

function formatActionReply(pic, lang) {
  const sym = pic.currencySymbol || "$";
  const f = (c) => fmt(c, sym);
  const lines = [];
  lines.push("*" + t(lang, "freeToday") + ": " + f(pic.freeRemainingTodayCents) + "*");
  lines.push(t(lang, "dailyPace") + " " + f(pic.dailyFreePaceCents) + " · " + pic.daysLeft + " " + t(lang, "daysWord"));
  const dueBills = pic.drains.filter(d => d.isDue);
  if (dueBills.length) {
    lines.push("⚠ *" + dueBills[0].name + "* " + t(lang, "due") + " — " + f(dueBills[0].amountCents || 0));
  }
  if (pic.freeRemainingTodayCents < 200 && pic.trulyFreeCents > 0) {
    lines.push(t(lang, "free") + ": " + f(pic.trulyFreeCents) + " / " + pic.daysLeft + " " + t(lang, "daysWord"));
  } else if (pic.trulyFreeCents < 0) {
    lines.push("⚠");
  }
  return lines.join("\n");
}

function formatMorningBriefing(pic, lang) {
  const sym = pic.currencySymbol || "$";
  const lines = [];
  if (pic.trulyFreeCents < 0) lines.push(lang === "ru" ? "Утро. Перерасход." : "Morning. You're over budget.");
  else if (pic.freeRemainingTodayCents < 500) lines.push(lang === "ru" ? "Утро. Туго сегодня." : "Morning. It's tight today.");
  else lines.push(lang === "ru" ? "Доброе утро!" : "Good morning!");
  lines.push("");
  lines.push("*" + t(lang, "freeToday") + ": " + fmt(pic.freeRemainingTodayCents, sym) + "*");
  lines.push(t(lang, "dailyPace") + " " + fmt(pic.dailyFreePaceCents, sym) + " · " + (pic.daysLeft === 0
    ? (lang === "ru" ? "сегодня" : "today")
    : pic.daysLeft + " " + t(lang, "daysWord")));
  return lines.join("\n");
}

function formatBillAlert(drain, pic, lang) {
  const sym = (pic && pic.currencySymbol) || "$";
  const days = daysUntil(drain.nextDate);
  const when = days <= 0
    ? (lang === "ru" ? "к оплате сегодня" : "due today")
    : (lang === "ru" ? "к оплате завтра" : "due tomorrow");
  return "⚠ *" + drain.name + "* " + when + " — " + fmt(drain.amountCents, sym);
}

function formatSpendFeed(pic, state, period, lang) {
  const sym = pic.currencySymbol || "$";
  const f = (c) => fmt(c, sym);
  const w = period === "week", L = [];
  L.push("*" + t(lang, w ? "feedWeek" : "feedMonth") + "*");
  L.push(f(w ? pic.thisWeekSpentCents : pic.thisMonthSpentCents) + " " + (w ? t(lang, "thisWeek").toLowerCase() : t(lang, "feedMonth").toLowerCase()));
  if (w) L.push(t(lang, "weeklyPace") + " " + f(pic.weeklyFreePaceCents));
  L.push(t(lang, "dailyPace") + " " + f(pic.dailyFreePaceCents));
  L.push("");
  const cd = new Date(); cd.setDate(cd.getDate() - (w ? 7 : 30));
  const cs = cd.toISOString().slice(0, 10);
  const txs = (state.transactions || [])
    .filter(tx => tx.date >= cs && (tx.type === "transaction" || tx.type === "refund"))
    .slice(-10).reverse();
  if (txs.length) {
    for (const tx of txs) {
      L.push((tx.date || "").slice(5) + " " + (tx.description || "").slice(0, 14).padEnd(14) + " " + f(tx.amountCents));
    }
  }
  return L.join("\n");
}

module.exports = {
  S, t, detectLang, fmt, daysUntil, today,
  formatPicture, formatActionReply,
  formatMorningBriefing, formatBillAlert, formatSpendFeed,
};
