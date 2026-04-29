"use strict";
// v4/currency.js — currency identity + conversion.
// Contract:
//   - convertSync(amountCents, fromCurrency, toCurrency) — never throws,
//     falls back to baked-in approximate rates if the API hasn't been
//     refreshed yet (or fails). Always returns an integer cents value.
//   - refreshRates() — fetches current cross-rates from frankfurter.app;
//     caches in-memory for 24h. Called on server start and once daily.
//   - symbolFor(code) — best-effort symbol mapping for display.
//   - normalize(code) — uppercase + strip whitespace.

const FALLBACK_RATES_USD = {
  // Approximate USD→X rates baked in. Used if the live API is unreachable.
  // Refreshed periodically on each redeploy. Do not ship dramatic moves
  // — these are fallbacks, not source of truth.
  USD: 1.000,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 150.0,
  CNY: 7.20,
  RUB: 92.0,
  INR: 83.5,
  CAD: 1.36,
  AUD: 1.52,
  CHF: 0.88,
  SEK: 10.5,
  NOK: 10.6,
  DKK: 6.85,
  PLN: 4.05,
  TRY: 32.0,
  BRL: 5.0,
  MXN: 17.0,
  KRW: 1340.0,
  SGD: 1.34,
  HKD: 7.82,
  ZAR: 18.5,
  NZD: 1.65,
  CZK: 23.0,
  HUF: 360.0,
  ILS: 3.65,
  AED: 3.673,
  SAR: 3.75,
  THB: 36.0,
  VND: 24500.0,
  PHP: 56.0,
  IDR: 15700.0,
  MYR: 4.7,
  UAH: 38.0,
  RON: 4.55,
  BGN: 1.80,
  CLP: 920.0,
  COP: 4000.0,
  ARS: 850.0,
  EGP: 47.0,
  PKR: 280.0,
  BDT: 120.0,
  NGN: 1500.0,
};

const SYMBOLS = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", RUB: "₽",
  INR: "₹", BRL: "R$", VND: "₫", THB: "฿", KRW: "₩", PLN: "zł",
  CZK: "Kč", TRY: "₺", AUD: "A$", CAD: "C$", NZD: "NZ$", SGD: "S$",
  HKD: "HK$", MXN: "$", CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr",
  ZAR: "R", HUF: "Ft", ILS: "₪", AED: "د.إ", SAR: "﷼", PHP: "₱",
  IDR: "Rp", MYR: "RM", UAH: "₴", RON: "lei", BGN: "лв", CLP: "$",
  COP: "$", ARS: "$", EGP: "E£", PKR: "₨", BDT: "৳", NGN: "₦",
};

let cachedRatesUSD = null;
let cachedAt = 0;
const RATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalize(code) {
  if (!code || typeof code !== "string") return "USD";
  const u = code.trim().toUpperCase();
  return u || "USD";
}

function symbolFor(code) {
  const k = normalize(code);
  return SYMBOLS[k] || k + " ";
}

// USD-anchored cross-rate. Returns { ratesUSD: { CODE: usdToCode } }.
function _activeRates() {
  if (cachedRatesUSD && (Date.now() - cachedAt) < RATE_CACHE_TTL_MS) return cachedRatesUSD;
  return FALLBACK_RATES_USD;
}

// from → USD → to. Multiplier: amount(from) * rate = amount(to).
function getRate(fromCode, toCode) {
  const from = normalize(fromCode);
  const to = normalize(toCode);
  if (from === to) return 1;
  const r = _activeRates();
  const fromRate = r[from] || FALLBACK_RATES_USD[from] || 1; // USD→from
  const toRate = r[to] || FALLBACK_RATES_USD[to] || 1;       // USD→to
  // amount(from) → USD: divide by fromRate
  // USD → to: multiply by toRate
  return toRate / fromRate;
}

// Convert integer cents from one currency to another. Returns integer cents.
function convertSync(amountCents, fromCode, toCode) {
  if (typeof amountCents !== "number" || !Number.isFinite(amountCents)) return 0;
  const rate = getRate(fromCode, toCode);
  return Math.round(amountCents * rate);
}

// Async refresh from frankfurter.app. Free, no auth, daily ECB rates +
// many extras. We anchor on USD.
async function refreshRates() {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && data.rates) {
      cachedRatesUSD = Object.assign({ USD: 1 }, data.rates);
      cachedAt = Date.now();
      return true;
    }
  } catch (e) {
    console.warn("[currency] refresh failed, using fallback:", e.message);
  }
  return false;
}

// Format an amount with its currency symbol. Integer-cent input.
function fmtMoney(cents, code) {
  const sym = symbolFor(code);
  if (cents == null) return sym + "0";
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const change = abs % 100;
  const intStr = dollars.toLocaleString("en-US"); // grouping always en-US for simplicity
  const str = intStr + (change ? "." + String(change).padStart(2, "0") : "");
  return (neg ? "-" : "") + sym + str;
}

module.exports = { normalize, symbolFor, getRate, convertSync, refreshRates, fmtMoney, FALLBACK_RATES_USD };
