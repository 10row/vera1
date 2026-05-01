"use strict";
// v5/currency.js — minimal multi-currency conversion for foreign spends.
//
// User on a Vietnam trip says "200000 dong on coffee" → AI emits the
// intent with originalAmountCents + originalCurrency. We convert to
// base currency here for the canonical amountCents. Both are stored
// so display can show "₫200,000 (≈$8.20)".
//
// Rates are static fallbacks (USD-quoted: 1 unit of CCY = N USD).
// This is "good enough for personal logging" — not a forex tool.
// If anyone needs exact, they can correct the spend manually after.

// 1 unit of CCY = N USD (rough, adjust periodically)
const RATES_TO_USD = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  RUB: 0.011,
  JPY: 0.0067,
  VND: 0.00004,
  AUD: 0.66,
  CAD: 0.74,
  INR: 0.012,
  CNY: 0.14,
  CHF: 1.13,
  SEK: 0.094,
  NOK: 0.094,
  PLN: 0.25,
  THB: 0.027,
  IDR: 0.000063,
  MYR: 0.21,
  SGD: 0.74,
  HKD: 0.13,
  KRW: 0.00074,
  TRY: 0.029,
  MXN: 0.058,
  BRL: 0.20,
  ZAR: 0.054,
};

const SYMBOLS = {
  USD: "$",  EUR: "€",  GBP: "£",  RUB: "₽",  JPY: "¥",  VND: "₫",
  AUD: "A$", CAD: "C$", INR: "₹",  CNY: "¥",  CHF: "CHF",
  SEK: "kr", NOK: "kr", PLN: "zł", THB: "฿",  IDR: "Rp",
  MYR: "RM", SGD: "S$", HKD: "HK$", KRW: "₩", TRY: "₺",
  MXN: "MX$", BRL: "R$", ZAR: "R",
};

function isSupported(code) {
  return code && typeof code === "string" && Object.prototype.hasOwnProperty.call(RATES_TO_USD, code.toUpperCase());
}

// Convert N cents of `from` currency to N cents of `to` currency.
// Both are in the SUBUNITS of their respective currency (cents, kopeks,
// VND has no subunit but we still treat as "1 unit = 100 micro-units"
// to keep our integer math consistent).
//
// Example: 200_000 cents of VND (= 200,000 ₫ literally) → ~820 cents of USD ($8.20).
function convertCents(amountCents, fromCcy, toCcy) {
  fromCcy = (fromCcy || "USD").toUpperCase();
  toCcy = (toCcy || "USD").toUpperCase();
  if (fromCcy === toCcy) return amountCents;
  if (!isSupported(fromCcy) || !isSupported(toCcy)) return amountCents;
  const usd = amountCents * RATES_TO_USD[fromCcy];
  const out = usd / RATES_TO_USD[toCcy];
  return Math.round(out);
}

function symbolFor(code) {
  return SYMBOLS[(code || "USD").toUpperCase()] || (code || "$");
}

// Pretty format with the currency's native symbol.
function fmt(amountCents, code) {
  const sym = symbolFor(code);
  if (amountCents == null) return sym + "0.00";
  const neg = amountCents < 0;
  const abs = Math.abs(amountCents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const change = String(abs % 100).padStart(2, "0");
  return (neg ? "-" : "") + sym + dollars + "." + change;
}

module.exports = { convertCents, isSupported, symbolFor, fmt, RATES_TO_USD, SYMBOLS };
