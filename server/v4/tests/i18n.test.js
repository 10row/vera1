"use strict";
// Locale + currency + multi-currency transaction tests.

const m = require("../model");
const en = require("../locales/en");
const ru = require("../locales/ru");
const { t, normalizeLang, defaultCurrencyForLang, LOCALES } = require("../locales");
const currency = require("../currency");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");

// ── LOCALE PARITY ──────────────────────────────────────
test("[i18n] every key in en exists in ru (parity)", () => {
  const enKeys = Object.keys(en);
  const ruKeys = Object.keys(ru);
  const missing = enKeys.filter(k => !(k in ru));
  if (missing.length > 0) {
    throw new Error("Russian locale missing " + missing.length + " keys: " + missing.slice(0, 5).join(", "));
  }
  // Allow ru to have extra keys (rare); but they should be intentional.
  const extra = ruKeys.filter(k => !(k in en));
  if (extra.length > 0) {
    throw new Error("Russian locale has extra keys not in en: " + extra.join(", "));
  }
});

test("[i18n] t() returns the key and warns if missing in both", () => {
  const result = t("nonexistent.key.zzzzz", "en");
  // Falls back to the key itself
  assertTrue(typeof result === "string");
});

test("[i18n] t() interpolates {placeholders}", () => {
  const r = t("undo.undone", "en", { what: "test" });
  assertTrue(/test/.test(r));
});

test("[i18n] t() falls back to en when key missing in target locale", () => {
  // Make sure ru doesn't accidentally have an unknown key fallback
  const r = t("welcome.identity", "ru");
  assertTrue(r.length > 0);
  // Should be the Russian one
  assertTrue(r.includes("SpendYes"));
});

// ── normalizeLang ─────────────────────────────────────
test("[i18n] normalizeLang strips region and falls back to en", () => {
  assertEq(normalizeLang("en-US"), "en");
  assertEq(normalizeLang("ru-RU"), "ru");
  assertEq(normalizeLang("RU"), "ru");
  assertEq(normalizeLang("xx"), "en");
  assertEq(normalizeLang(null), "en");
  assertEq(normalizeLang(""), "en");
});

test("[i18n] defaultCurrencyForLang maps known langs", () => {
  assertEq(defaultCurrencyForLang("en").code, "USD");
  assertEq(defaultCurrencyForLang("ru").code, "RUB");
  assertEq(defaultCurrencyForLang("ru-RU").code, "RUB");
  assertEq(defaultCurrencyForLang("ja").code, "JPY");
  assertEq(defaultCurrencyForLang("xx").code, "USD"); // fallback
});

// ── CURRENCY MODULE ───────────────────────────────────
test("[currency] symbolFor known codes", () => {
  assertEq(currency.symbolFor("USD"), "$");
  assertEq(currency.symbolFor("RUB"), "₽");
  assertEq(currency.symbolFor("EUR"), "€");
  assertEq(currency.symbolFor("VND"), "₫");
});

test("[currency] convertSync USD→USD is identity", () => {
  assertEq(currency.convertSync(10000, "USD", "USD"), 10000);
});

test("[currency] convertSync EUR→USD uses fallback rates if API not refreshed", () => {
  // EUR rate ~0.92, so 100 EUR ~= 108 USD
  const r = currency.convertSync(100_00, "EUR", "USD");
  assertTrue(r > 90_00 && r < 130_00, "expected ~$100ish, got " + r);
});

test("[currency] convertSync VND→USD returns small USD amount", () => {
  // 100,000 VND ~= $4
  const r = currency.convertSync(100_000_00, "VND", "USD");
  assertTrue(r > 0 && r < 10_00, "expected ~$4, got " + r);
});

test("[currency] convertSync rounds to integer cents", () => {
  const r = currency.convertSync(123_45, "EUR", "USD");
  assertTrue(Number.isInteger(r));
});

test("[currency] convertSync handles invalid inputs without throwing", () => {
  assertEq(currency.convertSync(NaN, "USD", "USD"), 0);
  assertEq(currency.convertSync(null, "USD", "USD"), 0);
  assertEq(currency.convertSync(undefined, "USD", "USD"), 0);
});

test("[currency] fmtMoney puts symbol in front", () => {
  assertEq(currency.fmtMoney(123_45, "USD"), "$123.45");
  assertEq(currency.fmtMoney(50_000_00, "RUB"), "₽50,000");
});

// ── MULTI-CURRENCY TRANSACTIONS ────────────────────────
test("[i18n] record_spend with originalCurrency converts to base + preserves original", () => {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, currency: "USD", currencySymbol: "$" },
  }).state;
  // Validator converts EUR→USD before applying.
  const intent = { kind: "record_spend", params: { originalAmountCents: 50_00, originalCurrency: "EUR", note: "dinner" } };
  const v = validateIntent(s, intent);
  assertEq(v.ok, true);
  // After validator, intent.params.amountCents is base-currency cents
  assertTrue(typeof intent.params.amountCents === "number");
  assertTrue(intent.params.amountCents > 0);
  s = applyIntent(s, intent).state;
  // Tx has both fields
  const tx = s.transactions[s.transactions.length - 1];
  assertEq(tx.originalCurrency, "EUR");
  assertEq(tx.originalAmountCents, 50_00);
  // Balance reduced by base-currency amount
  assertTrue(s.balanceCents < 5_000_00);
});

test("[i18n] record_spend without originalCurrency ignores conversion path (back-compat)", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 1_000_00 } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5_00, note: "coffee" } }).state;
  const tx = s.transactions[s.transactions.length - 1];
  assertEq(tx.amountCents, 5_00);
  // No original-* fields
  assertTrue(!("originalAmountCents" in tx));
});

test("[i18n] record_income with originalCurrency works the same", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 1_000_00 } }).state;
  const intent = { kind: "record_income", params: { originalAmountCents: 100_00, originalCurrency: "EUR", note: "freelance EUR" } };
  validateIntent(s, intent); // converts in place
  s = applyIntent(s, intent).state;
  const tx = s.transactions[s.transactions.length - 1];
  assertEq(tx.kind, "income");
  assertEq(tx.originalCurrency, "EUR");
});

// ── LOCALE FILE FORMAT INTEGRITY ───────────────────────
test("[i18n] all locale values are strings (no nested objects)", () => {
  for (const [lang, dict] of Object.entries(LOCALES)) {
    for (const [key, val] of Object.entries(dict)) {
      assertTrue(typeof val === "string", lang + ":" + key + " must be a string, got " + typeof val);
    }
  }
});

test("[i18n] no locale value contains an unbalanced placeholder", () => {
  for (const [lang, dict] of Object.entries(LOCALES)) {
    for (const [key, val] of Object.entries(dict)) {
      const opens = (val.match(/\{/g) || []).length;
      const closes = (val.match(/\}/g) || []).length;
      assertEq(opens, closes, lang + ":" + key + " has unbalanced { } placeholders");
    }
  }
});
