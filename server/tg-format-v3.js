"use strict";
const v3 = require("./vera-v3");
function today() { return new Date().toISOString().slice(0,10); }
function daysUntil(ds) { if (!ds) return 99; return Math.ceil((new Date(ds+"T00:00:00")-new Date(today()+"T00:00:00"))/86400000); }
const S = {
  en: {
    review: "\u{1F9E0} How'm I doing?", dashboard: "\u{1F4CA} Dashboard",
    paidBtn: "✓ Paid ", skipBtn: "Skip",
    confirmReceipt: "✓ Log it", editReceipt: "✏ Edit", cancelReceipt: "✗ Cancel",
    receiptReading: "_Reading your receipt..._",
    receiptFailed: "Couldn't read that receipt. Try typing it instead.",
    receiptEdit: "No problem — what's the correct amount?",
    notSetup: "I'm not set up yet. Send me a voice note about your situation — what's in your account, when you get paid, any regular bills.",
    error: "Something went wrong — try sending that again.",
    welcome: "Hey — I'm SpendYes! \u{1F44B}\n\nI show you what you *can* spend freely, so you never have to wonder.\n\nSend me a voice note about your situation — what's in your account, when you get paid, any regular bills. I'll handle the rest.",
    resetConfirm: "Everything's been wiped clean. Let's start fresh!\n\nSend me a voice note about your situation.",
    paidConfirm: "✓ *NAME* paid.", skippedConfirm: "Skipped *NAME* — next date moved forward.",
    undone: "Done — last action undone.", freeToday: "Free today",
    days: "d", daysWord: "days", due: "due",
  },
  ru: {
    review: "\u{1F9E0} Как дела?", dashboard: "\u{1F4CA} Панель",
    paidBtn: "✓ Оплачено ", skipBtn: "Пропустить",
    confirmReceipt: "✓ Записать", editReceipt: "✏ Исправить", cancelReceipt: "✗ Отмена",
    receiptReading: "_Читаю чек…_",
    receiptFailed: "Не смог прочитать. Напишите сами.",
    receiptEdit: "Какая правильная сумма?",
    notSetup: "Я ещё не настроен. Отправьте голосовое сообщение о вашей ситуации.",
    error: "Что-то пошло не так. Попробуйте ещё.",
    welcome: "Привет — я SpendYes! \u{1F44B}\n\nПоказываю сколько *можешь* тратить свободно.\n\nОтправьте голосовое сообщение о вашей ситуации.",
    resetConfirm: "Всё сброшено. Начнём заново!",
    paidConfirm: "✓ *NAME* оплачено.", skippedConfirm: "*NAME* пропущено — дата сдвинута.",
    undone: "Готово — последнее действие отменено.", freeToday: "Сегодня",
    days: "д", daysWord: "дн.", due: "к оплате",
  }
};
function t(lang, key) { return (S[lang]||S.en)[key]||S.en[key]||key; }
function detectLang(ctx) { const lc = ctx.from?.language_code||""; return lc.startsWith("ru")?"ru":"en"; }
function heroLine(pic, lang) {
  if (!pic||!pic.setup) return "";
  const sym = pic.currencySymbol||"$";
  const ft = pic.freeRemainingTodayFormatted||v3.toMoney(pic.freeRemainingTodayCents||0,sym);
  return "*"+t(lang,"freeToday")+": "+ft+"*";
}
function formatBriefing(pic, lang) {
  if (!pic||!pic.setup) return t(lang,"notSetup");
  const sym = pic.currencySymbol||"$", M = c => v3.toMoney(c,sym), lines = [];
  if (pic.freeCents<0) lines.push(lang==="ru"?"Утро. Перерасход.":"Morning. You're over budget.");
  else if ((pic.freeRemainingTodayCents||0)<500) lines.push(lang==="ru"?"Утро. Туго сегодня.":"Morning. It's tight today.");
  else lines.push(lang==="ru"?"Доброе утро!":"Good morning!");
  lines.push(heroLine(pic,lang));
  const pace = pic.dailyPaceFormatted||M(pic.dailyPaceCents||0), dl = pic.daysLeft??"?";
  lines.push(pace+"/"+t(lang,"days")+" · "+dl+" "+t(lang,"daysWord"));
  for (const d of (pic.dueEnvelopes||[])) {
    const amt = d.amountFormatted||M(d.amountCents||0);
    lines.push("⚠ *"+d.name+"* "+t(lang,"due")+" — "+amt);
  }
  return lines.join("\n");
}
function formatEnvelopeAlert(envelope, pic, lang) {
  const sym = (pic&&pic.currencySymbol)||"$", M = c => v3.toMoney(c,sym);
  const days = daysUntil(envelope.nextDate);
  const when = days<0?(lang==="ru"?"просрочено":"overdue"):days===0?(lang==="ru"?"к оплате сегодня":"due today"):(lang==="ru"?"к оплате завтра":"due tomorrow");
  return "⚠ *"+envelope.name+"* "+when+" — "+M(envelope.amountCents);
}
function mainKeyboard(lang, miniAppUrl) {
  const kb = { keyboard: [[{ text: t(lang,"review") }]], resize_keyboard: true };
  if (miniAppUrl) kb.keyboard[0].push({ text: t(lang,"dashboard"), web_app: { url: miniAppUrl } });
  return kb;
}
function dueButtons(envelopeName, lang) {
  const cbKey = envelopeName.slice(0,55);
  return { inline_keyboard: [[
    { text: t(lang,"paidBtn")+envelopeName, callback_data: "pay:"+cbKey },
    { text: t(lang,"skipBtn"), callback_data: "skip:"+cbKey },
  ]] };
}
function receiptButtons(lang) {
  return { inline_keyboard: [[
    { text: t(lang,"confirmReceipt"), callback_data: "receipt:confirm" },
    { text: t(lang,"editReceipt"), callback_data: "receipt:edit" },
    { text: t(lang,"cancelReceipt"), callback_data: "receipt:cancel" },
  ]] };
}
function formatReconciliation(pic, lang) {
  const sym = pic.currencySymbol||"$", bal = v3.toMoney(pic.balanceCents,sym);
  return lang==="ru"?"Быстрая проверка — на счёте всё ещё около "+bal+"?":"Quick check — is your bank balance still around "+bal+"?";
}
module.exports = { S,t,detectLang,today,daysUntil,heroLine,formatBriefing,formatEnvelopeAlert,formatReconciliation,mainKeyboard,dueButtons,receiptButtons };
