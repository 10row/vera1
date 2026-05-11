"use strict";
// v5/messages.js — central EN/RU message table for validator + engine
// errors that surface directly to the user.
//
// Problem this solves: validator/engine were emitting hardcoded English
// strings. Russian-language users got English error messages — e.g.
// "You already have a bill named Груминг собаки." Embarrassing and
// brand-damaging.
//
// Design:
//   - One flat table keyed by short code
//   - Each entry has en + ru variants
//   - Placeholders use {name} / {amount} style — interpolated by M()
//   - Lang argument normalizes to "en" | "ru" (default "en" fallback)
//   - Unknown code → returns code itself (so missing translations are
//     visible, not silent fallback to "")
//
// Engine throws Error objects with .code attached (e.g.
// `Object.assign(new Error("..."), { code: "alreadySetUp" })`). Callers
// catch and translate via M(lang, err.code, ...) — keeps engine
// language-agnostic and lets the call site decide presentation.
//
// Validator returns reject() with the FINAL string (validator already
// has access to state.language, so it can translate inline).

const MESSAGES = {
  // ── generic intent shape ──
  emptyIntent:     { en: "Empty intent.",                                    ru: "Пустое намерение." },
  missingKind:     { en: "Intent missing kind.",                             ru: "Намерение без типа." },
  unknownIntent:   { en: "I don't know how to do that.",                     ru: "Я пока не умею это делать." },

  // ── setup ──
  alreadySetUp:    { en: "You're already set up. Tell me a balance change with \"actually I have $X\" instead.",
                     ru: "Уже настроено. Скажи изменение баланса так: «вообще-то у меня сейчас $X»." },
  notANumber:      { en: "That doesn't look like a number.",                 ru: "Это не похоже на число." },
  negativeBalance: { en: "Balance can't be negative.",                       ru: "Баланс не может быть отрицательным." },
  balanceTooLarge: { en: "That balance is too large to track here.",         ru: "Слишком большой баланс для этой системы." },
  setupFirstAsk:   { en: "Set up first — what's your starting balance?",    ru: "Сначала настройся — какой стартовый баланс?" },
  setupFirst:      { en: "Set up first.",                                    ru: "Сначала настройся." },

  // ── bills ──
  billNeedsName:   { en: "What's the bill called?",                          ru: "Как называется счёт?" },
  billNeedsAmount: { en: "Need a valid amount for {name}.",                  ru: "Нужна корректная сумма для {name}." },
  billNeedsDueDate:{ en: "Need a due date for {name}.",                      ru: "Нужна дата для {name}." },
  billPastDate:    { en: "That date's in the past — pick a future one.",    ru: "Эта дата в прошлом — нужна будущая." },
  badRecurrence:   { en: "Recurrence should be once/weekly/biweekly/monthly.",
                     ru: "Повторение должно быть once/weekly/biweekly/monthly." },
  dupBillName:     { en: "You already have a bill named {name}.",            ru: "Счёт «{name}» уже есть." },
  noBillByName:    { en: "No bill by that name.",                            ru: "Нет счёта с таким названием." },
  noBillMatch:     { en: "No bill matching {name}.",                         ru: "Нет счёта, похожего на «{name}»." },

  // ── spend / income ──
  needValidAmount: { en: "Need a valid amount.",                             ru: "Нужна корректная сумма." },
  spendOverBalance:{ en: "That's more than your balance — really {amount}?", ru: "Это больше твоего баланса — точно {amount}?" },

  // ── payday ──
  badDateFormat:   { en: "That date didn't parse — try YYYY-MM-DD.",        ru: "Дата не распознана — попробуй формат ГГГГ-ММ-ДД." },
  badPayFrequency: { en: "Frequency should be weekly/biweekly/monthly/irregular.",
                     ru: "Частота должна быть weekly/biweekly/monthly/irregular." },

  // ── undo / delete ──
  nothingToUndo:   { en: "Nothing to undo yet.",                             ru: "Пока нечего отменять." },
  cantUndoSetup:   { en: "Can't undo setup. Use reset.",                     ru: "Настройку нельзя отменить — используй сброс." },
  cantUndoKind:    { en: "Can't undo {kind}",                                ru: "Нельзя отменить {kind}" },
  txNotFound:      { en: "Couldn't find that transaction.",                  ru: "Не могу найти эту транзакцию." },
  txAlreadyDeleted:{ en: "That one's already deleted.",                       ru: "Уже удалено." },
  cantDeleteSetup: { en: "Can't delete the starting balance — use /reset for a fresh start.",
                     ru: "Стартовый баланс не удалить — используй /reset для полного сброса." },
  txIdRequired:    { en: "Need a transaction id to delete.",                  ru: "Нужен идентификатор транзакции для удаления." },

  // ── engine validation throws ──
  engineInvalidAmount:   { en: "Invalid amount",                             ru: "Некорректная сумма" },
  engineInvalidBalance:  { en: "Invalid balance",                            ru: "Некорректный баланс" },
  engineBillNameRequired:{ en: "Bill needs a name",                          ru: "Счёту нужно название" },
  engineDueDateInvalid:  { en: "Need a valid due date",                      ru: "Нужна корректная дата" },
  engineDupBill:         { en: "Bill already exists: {name}",                ru: "Счёт уже существует: {name}" },
  engineNoSuchBill:      { en: "No such bill: {name}",                       ru: "Нет такого счёта: {name}" },
  engineDateInvalid:     { en: "Invalid date",                               ru: "Некорректная дата" },
  engineSetupAlready:    { en: "Already set up. Use adjust_balance or update_payday.",
                           ru: "Уже настроено. Используй коррекцию баланса или обновление зарплаты." },
  engineBalanceTooLarge: { en: "Balance too large",                          ru: "Слишком большой баланс" },

  // ── pipeline silent-lie fallback ──
  silentLieFallback:     { en: "I'm not sure what to do with that — could you be more specific?",
                           ru: "Не совсем понял — можно поточнее?" },

  // ── clarify (soft reject — bot asks the user, no buttons) ──
  // Used when the AI proposed an intent but a required field is missing.
  // These are QUESTIONS, not errors — the bot renders them as plain text
  // and the user types a follow-up. NEVER show confirm buttons on a
  // clarify; the user hasn't supplied enough info to confirm anything yet.
  clarifyBillDueDate:    { en: "By when do you need it? (a date — \"Friday\", \"the 15th\", \"in 3 weeks\")",
                           ru: "К какому числу? («в пятницу», «к 15-му», «через 3 недели»)" },
  clarifyBillName:       { en: "What should I call this commitment?",
                           ru: "Как назвать эту цель?" },
  clarifyBillAmount:     { en: "How much for {name}?",
                           ru: "Сколько на {name}?" },
  clarifySpendAmount:    { en: "How much did you spend?",
                           ru: "Сколько потратил?" },
  clarifyIncomeAmount:   { en: "How much did you receive?",
                           ru: "Сколько получил?" },
  clarifyAdjustBalance:  { en: "What's the new balance?",
                           ru: "Какой новый баланс?" },

  // ── confirm-button labels (per-intent — \"Yes\" is ambiguous on a question) ──
  // The generic \"Yes / Cancel\" got confused for \"Yes I want this\" vs
  // \"Yes the answer is yes.\" Per-intent verbs are unambiguous.
  btnReserve:            { en: "Reserve",                                    ru: "Отложить" },
  btnAddBill:            { en: "Add bill",                                   ru: "Добавить" },
  btnRemoveBill:         { en: "Remove",                                     ru: "Удалить" },
  btnLogSpend:           { en: "Log it",                                     ru: "Записать" },
  btnLogIncome:          { en: "Log income",                                 ru: "Записать доход" },
  btnUpdateBalance:      { en: "Update",                                     ru: "Обновить" },
  btnUpdatePayday:       { en: "Update payday",                              ru: "Обновить" },
  btnUndo:               { en: "Undo",                                       ru: "Отменить" },
  btnDelete:             { en: "Delete",                                     ru: "Удалить" },
  btnReset:              { en: "Reset everything",                           ru: "Сбросить всё" },
  btnConfirm:            { en: "Confirm",                                    ru: "Подтвердить" },
  btnCancel:             { en: "Cancel",                                     ru: "Отмена" },

  // ── bot ──
  miniAppNotConfigured:  { en: "Mini app not configured.",                   ru: "Mini app не настроен." },
  miniAppOpen:           { en: "Open the mini app:",                         ru: "Открыть mini app:" },
};

function M(lang, code, params) {
  const lc = lang === "ru" ? "ru" : "en";
  const entry = MESSAGES[code];
  if (!entry) return String(code); // makes missing codes loudly visible in dev
  const tmpl = entry[lc] || entry.en || String(code);
  if (!params) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => params[k] != null ? String(params[k]) : ("{" + k + "}"));
}

module.exports = { M, MESSAGES };
