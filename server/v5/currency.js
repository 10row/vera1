"use strict";
// v5/currency.js — multi-currency conversion done correctly.
//
// Two corrections from v1:
// 1) Currencies have different DECIMAL PLACES.
//    USD/EUR/GBP/RUB → 2 decimals (cents).
//    VND/JPY/KRW/IDR → 0 decimals (whole units only).
//    Storing "200000" as "cents of VND" produced "₫2,000.00" — wrong.
// 2) The AI now sends `originalAmount` as the SPOKEN NUMBER (natural).
//    User says "200,000 VND" → originalAmount = 200000.
//    User says "€40.50"      → originalAmount = 40.50.
//    Backend converts to canonical subunits per currency.

// 1 unit (NOT subunit) of CCY = N USD. Adjust periodically.
const RATES_TO_USD = {
  USD: 1,         EUR: 1.08,      GBP: 1.27,      RUB: 0.011,
  JPY: 0.0067,    VND: 0.00004,   AUD: 0.66,      CAD: 0.74,
  INR: 0.012,     CNY: 0.14,      CHF: 1.13,      SEK: 0.094,
  NOK: 0.094,     PLN: 0.25,      THB: 0.027,     IDR: 0.000063,
  MYR: 0.21,      SGD: 0.74,      HKD: 0.13,      KRW: 0.00074,
  TRY: 0.029,     MXN: 0.058,     BRL: 0.20,      ZAR: 0.054,
};

// Number of fractional digits the currency actually uses. Critical
// because storing 200,000 VND as "cents" (i.e. × 100) is wrong — VND
// has no subunit. JPY/KRW/IDR same story.
const DECIMALS = {
  USD: 2, EUR: 2, GBP: 2, RUB: 2, AUD: 2, CAD: 2, INR: 2, CNY: 2,
  CHF: 2, SEK: 2, NOK: 2, PLN: 2, THB: 2, MYR: 2, SGD: 2, HKD: 2,
  TRY: 2, MXN: 2, BRL: 2, ZAR: 2,
  // No-decimal currencies:
  VND: 0, JPY: 0, KRW: 0, IDR: 0,
};

const SYMBOLS = {
  USD: "$",  EUR: "€",  GBP: "£",  RUB: "₽",  JPY: "¥",  VND: "₫",
  AUD: "A$", CAD: "C$", INR: "₹",  CNY: "¥",  CHF: "CHF",
  SEK: "kr", NOK: "kr", PLN: "zł", THB: "฿",  IDR: "Rp",
  MYR: "RM", SGD: "S$", HKD: "HK$", KRW: "₩", TRY: "₺",
  MXN: "MX$", BRL: "R$", ZAR: "R",
};

function isSupported(code) {
  if (!code || typeof code !== "string") return false;
  return Object.prototype.hasOwnProperty.call(RATES_TO_USD, code.toUpperCase());
}

function decimalsFor(code) {
  const c = (code || "USD").toUpperCase();
  return Object.prototype.hasOwnProperty.call(DECIMALS, c) ? DECIMALS[c] : 2;
}

function symbolFor(code) {
  return SYMBOLS[(code || "USD").toUpperCase()] || (code || "$");
}

// Spoken-amount → canonical subunits. The "subunit" depends on the
// currency's decimals: cents for USD, whole units for VND.
//   spokenToSubunits(40, "USD") → 4000  (40 dollars = 4000 cents)
//   spokenToSubunits(40.50, "USD") → 4050
//   spokenToSubunits(200000, "VND") → 200000 (no subunit, the amount IS subunits)
//   spokenToSubunits(1500, "JPY") → 1500
function spokenToSubunits(amount, code) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const dec = decimalsFor(code);
  return Math.round(n * Math.pow(10, dec));
}

// Convert N subunits of `from` to N subunits of `to`, accounting for
// each currency's decimals. The math: subunits / 10^decimals = whole
// units → multiply by rate to get USD whole units → multiply by 10^to.decimals.
function convertSubunits(amountSubunits, fromCcy, toCcy) {
  fromCcy = (fromCcy || "USD").toUpperCase();
  toCcy = (toCcy || "USD").toUpperCase();
  if (fromCcy === toCcy) return Math.round(amountSubunits);
  if (!isSupported(fromCcy) || !isSupported(toCcy)) return Math.round(amountSubunits);
  const fromWhole = amountSubunits / Math.pow(10, decimalsFor(fromCcy));
  const usd = fromWhole * RATES_TO_USD[fromCcy];
  const toWhole = usd / RATES_TO_USD[toCcy];
  return Math.round(toWhole * Math.pow(10, decimalsFor(toCcy)));
}

// Display formatter that respects per-currency decimals. So:
//   fmt(200000, "VND") → "₫200,000"  (NOT "₫2,000.00")
//   fmt(4050, "USD")   → "$40.50"
//   fmt(1500, "JPY")   → "¥1,500"
function fmt(amountSubunits, code) {
  const sym = symbolFor(code);
  if (amountSubunits == null) return sym + "0";
  const dec = decimalsFor(code);
  const factor = Math.pow(10, dec);
  const neg = amountSubunits < 0;
  const abs = Math.abs(amountSubunits);
  const whole = Math.floor(abs / factor).toLocaleString("en-US");
  if (dec === 0) return (neg ? "-" : "") + sym + whole;
  const change = String(abs % factor).padStart(dec, "0");
  return (neg ? "-" : "") + sym + whole + "." + change;
}

// Backward-compatible alias used elsewhere in the codebase. The
// argument is the canonical amount-in-subunits per the currency's
// decimals (so for USD = cents, VND = whole units).
function convertCents(amountSubunits, fromCcy, toCcy) {
  return convertSubunits(amountSubunits, fromCcy, toCcy);
}

module.exports = {
  RATES_TO_USD, DECIMALS, SYMBOLS,
  isSupported, decimalsFor, symbolFor,
  spokenToSubunits, convertSubunits, convertCents, fmt,
};
