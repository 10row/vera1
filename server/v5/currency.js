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
//
// LIVE RATES (added after the THB-rate-stale bug):
// - Daily cron in rate-fetcher.js pulls fresh rates from Frankfurter
//   (free ECB-backed service) and persists to the CurrencyRate table.
// - On bot startup + after each cron run, hydrateRateCache() loads
//   the last 90 days of rates into a module-level Map.
// - convertSubunits() consults the cache by (date, currency) — exact
//   match, then walks back up to 14 days for the most recent rate
//   (handles weekends / holidays / API outages).
// - Falls back to hardcoded RATES_TO_USD if cache misses entirely.
// - Stays SYNCHRONOUS so callers don't have to thread through async.

// 1 unit (NOT subunit) of CCY = N USD. HARDCODED FALLBACK ONLY —
// loaded into convertSubunits as last-resort if DB cache misses.
// Rates fetched live override these.
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

// Live-rate cache: Map<dateISO+ccy → ratePerUSD>. Hydrated by
// hydrateRateCache(prisma) on bot start and after each cron fetch.
// Empty by default — convertSubunits falls back to RATES_TO_USD.
const _liveRates = new Map();
let _liveLoadedAt = 0;
let _liveLatestDate = null;
function _key(date, ccy) { return date + "|" + ccy; }

// Resolve a rate for (date, currency). Walks back up to 14 days from
// the requested date to handle weekends, holidays, fetch gaps. Returns
// the cached ratePerUSD, or null if nothing in window.
function _liveLookup(date, ccy) {
  if (!date || !ccy || _liveRates.size === 0) return null;
  // Direct hit?
  let r = _liveRates.get(_key(date, ccy));
  if (r != null) return r;
  // Walk back up to 14 days.
  const y = +date.slice(0, 4), mo = +date.slice(5, 7) - 1, da = +date.slice(8, 10);
  for (let i = 1; i <= 14; i++) {
    const dt = new Date(Date.UTC(y, mo, da - i));
    const candidate = dt.toISOString().slice(0, 10);
    r = _liveRates.get(_key(candidate, ccy));
    if (r != null) return r;
  }
  return null;
}

// Resolve a rate-per-USD: prefer live cache by date, fall back to
// hardcoded. Used by convertSubunits and exposed for fmt-with-source
// label in UI.
function _rateFor(ccy, date) {
  if (ccy === "USD") return 1;
  // If date provided, try live cache. Otherwise try latest-known live
  // (the cache key set always sorts; we kept _liveLatestDate as a hint).
  if (date) {
    const live = _liveLookup(date, ccy);
    if (live != null) return live;
  } else if (_liveLatestDate) {
    const live = _liveRates.get(_key(_liveLatestDate, ccy));
    if (live != null) return live;
  }
  return RATES_TO_USD[ccy] != null ? RATES_TO_USD[ccy] : null;
}

// Convert N subunits of `from` to N subunits of `to`, accounting for
// each currency's decimals. The math: subunits / 10^decimals = whole
// units → multiply by rate to get USD whole units → multiply by 10^to.decimals.
//
// Optional `dateISO` argument (YYYY-MM-DD): if provided, looks up the
// live rate FROM THAT DAY (historical accuracy for backdated spends).
// Defaults to most-recent live rate. Falls back to hardcoded if no
// live rate is available.
function convertSubunits(amountSubunits, fromCcy, toCcy, dateISO) {
  fromCcy = (fromCcy || "USD").toUpperCase();
  toCcy = (toCcy || "USD").toUpperCase();
  if (fromCcy === toCcy) return Math.round(amountSubunits);
  if (!isSupported(fromCcy) || !isSupported(toCcy)) return Math.round(amountSubunits);
  const fromRate = _rateFor(fromCcy, dateISO);
  const toRate = _rateFor(toCcy, dateISO);
  if (fromRate == null || toRate == null) return Math.round(amountSubunits);
  const fromWhole = amountSubunits / Math.pow(10, decimalsFor(fromCcy));
  const usd = fromWhole * fromRate;
  const toWhole = usd / toRate;
  return Math.round(toWhole * Math.pow(10, decimalsFor(toCcy)));
}

// Hydrate the live-rate cache from the DB. Loads the last 90 days
// for the supported currencies. Idempotent — safe to call repeatedly
// (clears + reloads). Bot startup + after each cron fetch.
async function hydrateRateCache(prisma, days) {
  if (!prisma) return 0;
  days = Math.max(1, Math.min(days || 90, 365));
  const m = require("./model");
  const today = m.today("UTC");
  const since = m.addDays(today, -days);
  try {
    const rows = await prisma.currencyRate.findMany({
      where: { date: { gte: since } },
      orderBy: { date: "desc" },
    });
    _liveRates.clear();
    let latest = null;
    for (const row of rows) {
      _liveRates.set(_key(row.date, row.currency), row.ratePerUSD);
      if (!latest || row.date > latest) latest = row.date;
    }
    _liveLoadedAt = Date.now();
    _liveLatestDate = latest;
    return rows.length;
  } catch (e) {
    // DB unavailable — silently fall through to hardcoded rates.
    console.warn("[currency] hydrateRateCache failed:", e.message);
    return 0;
  }
}

// Test helper — directly seed the cache without DB. Used in unit tests.
function _testSeedCache(entries) {
  _liveRates.clear();
  _liveLatestDate = null;
  for (const e of (entries || [])) {
    _liveRates.set(_key(e.date, e.currency), e.ratePerUSD);
    if (!_liveLatestDate || e.date > _liveLatestDate) _liveLatestDate = e.date;
  }
  _liveLoadedAt = Date.now();
}

function _testClearCache() {
  _liveRates.clear();
  _liveLoadedAt = 0;
  _liveLatestDate = null;
}

function getRateSource(ccy, date) {
  if (!ccy || ccy === "USD") return "exact";
  const live = date ? _liveLookup(date, ccy) : (_liveLatestDate ? _liveRates.get(_key(_liveLatestDate, ccy)) : null);
  if (live != null) return "live";
  return RATES_TO_USD[ccy] != null ? "fallback" : "missing";
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
  hydrateRateCache, getRateSource,
  _testSeedCache, _testClearCache, // test-only
};
