"use strict";
// v5/rate-fetcher.js — fetch daily mid-market currency rates from
// Frankfurter (api.frankfurter.app) and persist to CurrencyRate.
//
// Frankfurter is a free public service backed by ECB published rates.
// No API key, no rate limit. Weekday updates only (ECB doesn't publish
// on weekends/holidays); we accept that and fall back to most-recent.
//
// API shape: GET https://api.frankfurter.app/latest?base=USD
//   → { amount: 1, base: "USD", date: "2026-05-06",
//       rates: { EUR: 0.93, GBP: 0.79, THB: 35.10, VND: 25400, ... } }
//
// "rate" in Frankfurter response = how many UNITS of target you get
// for 1 USD. We invert to ratePerUSD = how many USD ONE UNIT of
// target is worth. THB rate 35.10 → ratePerUSD = 1/35.10 = 0.0285.
//
// Historical: GET /YYYY-MM-DD?base=USD returns the rate as of that
// publication day. Used for backfill.
//
// Pure module: takes a prisma client, exposes fetch + persist
// functions. No side effects on import.

const FRANKFURTER_BASE = "https://api.frankfurter.app";
const m = require("./model");

// All currencies we support (mirror v5/currency.js RATES_TO_USD).
const SUPPORTED = [
  "EUR", "GBP", "RUB", "JPY", "VND", "AUD", "CAD",
  "INR", "CNY", "CHF", "SEK", "NOK", "PLN", "THB", "IDR",
  "MYR", "SGD", "HKD", "KRW", "TRY", "MXN", "BRL", "ZAR",
];

// Frankfurter doesn't include all currencies — RUB and IDR fall back
// to hardcoded rates if Frankfurter omits them. Document the gap.
const FRANKFURTER_OMITS = new Set([]); // updated dynamically based on responses

async function fetchRatesForDate(dateOrLatest) {
  const path = dateOrLatest === "latest" ? "/latest" : "/" + dateOrLatest;
  const url = FRANKFURTER_BASE + path + "?base=USD&symbols=" + SUPPORTED.join(",");
  // Use built-in fetch (Node 18+).
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Frankfurter HTTP " + res.status + " for " + path);
  }
  const json = await res.json();
  if (!json || !json.rates || typeof json.rates !== "object") {
    throw new Error("Frankfurter bad payload for " + path);
  }
  // json.rates: { EUR: 0.93, ... } where value = USD-units → target-units.
  // Invert to ratePerUSD: 1 unit of target = X USD.
  const out = { date: json.date, rates: {} };
  for (const ccy of SUPPORTED) {
    const r = json.rates[ccy];
    if (!Number.isFinite(r) || r <= 0) continue; // skip omissions
    out.rates[ccy] = 1 / r;
  }
  return out;
}

// Persist a snapshot. Idempotent — uses upsert on (date, currency).
async function persistSnapshot(prisma, snapshot) {
  const ops = [];
  for (const [ccy, ratePerUSD] of Object.entries(snapshot.rates)) {
    ops.push(prisma.currencyRate.upsert({
      where: { date_currency: { date: snapshot.date, currency: ccy } },
      create: { date: snapshot.date, currency: ccy, ratePerUSD, source: "frankfurter" },
      update: { ratePerUSD, fetchedAt: new Date() },
    }));
  }
  await Promise.all(ops);
  return ops.length;
}

// Fetch + persist today (or "latest" published rate).
async function fetchToday(prisma) {
  const snap = await fetchRatesForDate("latest");
  const count = await persistSnapshot(prisma, snap);
  console.log("[rates] fetched " + count + " currencies for " + snap.date);
  return { date: snap.date, count };
}

// Backfill historical rates for the last N days. Idempotent — safe to
// re-run. Frankfurter publishes ECB rates so weekends/holidays return
// the most-recent business day's rate; we store under each requested
// date, accepting the small inaccuracy on holidays.
async function backfill(prisma, days) {
  days = Math.max(1, Math.min(days || 90, 365));
  const today = m.today("UTC");
  let total = 0;
  for (let i = 0; i < days; i++) {
    const date = m.addDays(today, -i);
    try {
      const snap = await fetchRatesForDate(date);
      const count = await persistSnapshot(prisma, snap);
      total += count;
      // Be polite to a free public service.
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.warn("[rates] backfill skip " + date + ": " + e.message);
    }
  }
  console.log("[rates] backfilled " + total + " rate rows over " + days + " days");
  return total;
}

// Look up a rate from the DB. Returns ratePerUSD or null.
//   - tries exact (date, currency) match first
//   - if absent, walks back up to 14 days for the most-recent rate
//     (handles weekends, holidays, API outages on the target day)
//   - returns null if nothing found in window — caller falls back to
//     hardcoded table
async function lookupRate(prisma, date, currency) {
  if (!date || !currency) return null;
  const ccy = currency.toUpperCase();
  if (ccy === "USD") return 1;
  // Most-recent on or before `date`. Walks back up to 14 days.
  const row = await prisma.currencyRate.findFirst({
    where: {
      currency: ccy,
      date: { lte: date, gte: m.addDays(date, -14) },
    },
    orderBy: { date: "desc" },
  });
  return row ? row.ratePerUSD : null;
}

module.exports = {
  SUPPORTED,
  fetchRatesForDate,
  persistSnapshot,
  fetchToday,
  backfill,
  lookupRate,
};
