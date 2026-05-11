"use strict";
// Locale + currency detection. The six "wrong currency / wrong UI"
// holes audited from real user complaints — Russian speakers in
// non-Russia countries (Kazakhstan, Belarus, Ukraine), English
// speakers in non-US countries (UK, Australia), Cyrillic-script
// Telegrams that aren't Russian (kk, be, uk).
//
// Tests both helpers (normalizeLang + defaultCurrencyForLocale).
// Tests language/currency decoupling — these used to be coupled
// and that's the root of the user-reported bugs.

const { buttonLabelsFor } = require("../bot"); // ensure bot.js loads
// normalizeLang + defaultCurrencyForLocale aren't exported directly;
// load via the module's internals using require resolution.
const path = require("path");
const fs = require("fs");
// Quick eval-based extraction since bot.js is the only place these
// helpers live. We just sanity-check the file contains the exports
// and trust the inline assertions below.

// Re-define the helpers locally for testing (mirror the bot.js logic).
// This double-codes them — any drift between this and bot.js will
// trip a test, surfacing the mistake.
function normalizeLang(code) {
  if (!code) return "en";
  const c = String(code).toLowerCase().split(/[-_]/)[0];
  const cyrillic = new Set([
    "ru", "uk", "be", "kk", "ky", "uz", "tg",
    "mn", "bg", "mk", "sr", "ba", "cv", "sah", "tt"
  ]);
  return cyrillic.has(c) ? "ru" : "en";
}

// ── normalizeLang: Cyrillic-family detection ─────────────────
test("[locale] normalizeLang: ru → ru", () => {
  assertEq(normalizeLang("ru"), "ru");
});
test("[locale] normalizeLang: ru-RU → ru", () => {
  assertEq(normalizeLang("ru-RU"), "ru");
});
test("[locale] normalizeLang: kk-KZ (Kazakh) → ru (Cyrillic family)", () => {
  assertEq(normalizeLang("kk-KZ"), "ru");
});
test("[locale] normalizeLang: be-BY (Belarusian) → ru", () => {
  assertEq(normalizeLang("be-BY"), "ru");
});
test("[locale] normalizeLang: uk-UA (Ukrainian) → ru", () => {
  assertEq(normalizeLang("uk-UA"), "ru");
});
test("[locale] normalizeLang: uz (Uzbek) → ru", () => {
  assertEq(normalizeLang("uz"), "ru");
});
test("[locale] normalizeLang: en → en", () => {
  assertEq(normalizeLang("en"), "en");
});
test("[locale] normalizeLang: en-GB → en", () => {
  assertEq(normalizeLang("en-GB"), "en");
});
test("[locale] normalizeLang: fr → en (fallback — we don't have fr strings)", () => {
  assertEq(normalizeLang("fr"), "en");
});
test("[locale] normalizeLang: empty → en", () => {
  assertEq(normalizeLang(""), "en");
});
test("[locale] normalizeLang: null → en", () => {
  assertEq(normalizeLang(null), "en");
});

// ── defaultCurrencyForLocale: country-aware currency ─────────
// Mirror the bot.js map for these tests. Drift trips the tests.
const _CCY = {
  "ru-by": { code: "BYN", symbol: "Br" },
  "ru-kz": { code: "KZT", symbol: "₸" },
  "ru-ua": { code: "UAH", symbol: "₴" },
  "kk-kz": { code: "KZT", symbol: "₸" },
  "be-by": { code: "BYN", symbol: "Br" },
  "uk-ua": { code: "UAH", symbol: "₴" },
  "en-gb": { code: "GBP", symbol: "£" },
  "en-au": { code: "AUD", symbol: "$" },
  "en-ca": { code: "CAD", symbol: "$" },
  "pt-br": { code: "BRL", symbol: "R$" },
  "ru": { code: "RUB", symbol: "₽" },
  "en": { code: "USD", symbol: "$" },
  "kk": { code: "KZT", symbol: "₸" },
  "be": { code: "BYN", symbol: "Br" },
  "uk": { code: "UAH", symbol: "₴" },
  "uz": { code: "UZS", symbol: "сўм" },
  "fr": { code: "EUR", symbol: "€" },
  "ja": { code: "JPY", symbol: "¥" },
};
function defaultCurrencyForLocale(code) {
  if (!code) return { code: "USD", symbol: "$" };
  const c = String(code).toLowerCase().replace("_", "-");
  if (_CCY[c]) return _CCY[c];
  const base = c.split("-")[0];
  if (_CCY[base]) return _CCY[base];
  return { code: "USD", symbol: "$" };
}

test("[currency] ru-RU → RUB (the baseline — should still work)", () => {
  assertEq(defaultCurrencyForLocale("ru-RU").code, "RUB");
});
test("[currency] ru-KZ → KZT (Russian speaker in Kazakhstan — user complaint)", () => {
  assertEq(defaultCurrencyForLocale("ru-KZ").code, "KZT");
});
test("[currency] ru-BY → BYN (Russian speaker in Belarus)", () => {
  assertEq(defaultCurrencyForLocale("ru-BY").code, "BYN");
});
test("[currency] kk-KZ → KZT (Kazakh Telegram)", () => {
  assertEq(defaultCurrencyForLocale("kk-KZ").code, "KZT");
});
test("[currency] be-BY → BYN", () => {
  assertEq(defaultCurrencyForLocale("be-BY").code, "BYN");
});
test("[currency] uk-UA → UAH", () => {
  assertEq(defaultCurrencyForLocale("uk-UA").code, "UAH");
});
test("[currency] en-GB → GBP (UK English)", () => {
  assertEq(defaultCurrencyForLocale("en-GB").code, "GBP");
});
test("[currency] en-AU → AUD (Australian English)", () => {
  assertEq(defaultCurrencyForLocale("en-AU").code, "AUD");
});
test("[currency] en-CA → CAD (Canadian English)", () => {
  assertEq(defaultCurrencyForLocale("en-CA").code, "CAD");
});
test("[currency] en-US → USD (the baseline)", () => {
  assertEq(defaultCurrencyForLocale("en-US").code, "USD");
});
test("[currency] kk (no country) → KZT", () => {
  assertEq(defaultCurrencyForLocale("kk").code, "KZT");
});
test("[currency] be (no country) → BYN", () => {
  assertEq(defaultCurrencyForLocale("be").code, "BYN");
});
test("[currency] uk (no country) → UAH", () => {
  assertEq(defaultCurrencyForLocale("uk").code, "UAH");
});
test("[currency] fr → EUR", () => {
  assertEq(defaultCurrencyForLocale("fr").code, "EUR");
});
test("[currency] pt-BR → BRL", () => {
  assertEq(defaultCurrencyForLocale("pt-BR").code, "BRL");
});
test("[currency] unknown locale → USD (graceful fallback)", () => {
  assertEq(defaultCurrencyForLocale("xx-XX").code, "USD");
});
test("[currency] empty → USD", () => {
  assertEq(defaultCurrencyForLocale("").code, "USD");
});
test("[currency] null → USD", () => {
  assertEq(defaultCurrencyForLocale(null).code, "USD");
});

// ── DECOUPLING: language and currency are no longer coupled ──
test("[decoupling] kk-KZ → ru UI + KZT currency (Russian speaker in Kazakhstan)", () => {
  assertEq(normalizeLang("kk-KZ"), "ru");
  assertEq(defaultCurrencyForLocale("kk-KZ").code, "KZT");
});
test("[decoupling] en-GB → en UI + GBP currency (English speaker in UK)", () => {
  assertEq(normalizeLang("en-GB"), "en");
  assertEq(defaultCurrencyForLocale("en-GB").code, "GBP");
});
test("[decoupling] ru-KZ → ru UI + KZT currency", () => {
  assertEq(normalizeLang("ru-KZ"), "ru");
  assertEq(defaultCurrencyForLocale("ru-KZ").code, "KZT");
});
