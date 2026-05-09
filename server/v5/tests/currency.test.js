"use strict";
// Currency conversion tests — focus on the live-rate cache behavior
// added after the THB-rate-stale bug. Verifies:
//   - cache-driven conversion overrides hardcoded fallback
//   - historical date lookup works for backdated spends
//   - falls back to hardcoded when cache is empty
//   - falls back to hardcoded when currency missing from cache
//   - walks back up to 14 days when exact-date rate missing
const currency = require("../currency");
const m = require("../model");

function setupCache() {
  currency._testClearCache();
  // Seed THB at the new live rate (0.031) for today and a couple days back.
  const today = m.today("UTC");
  currency._testSeedCache([
    { date: today, currency: "THB", ratePerUSD: 0.0310 },
    { date: m.addDays(today, -1), currency: "THB", ratePerUSD: 0.0309 },
    { date: m.addDays(today, -3), currency: "THB", ratePerUSD: 0.0305 },
    { date: today, currency: "EUR", ratePerUSD: 1.176 },
  ]);
}

test("[currency] convertSubunits uses LIVE rate from cache when present", () => {
  setupCache();
  // 2,000 THB at live rate 0.0310 = $62.00 → 6200 cents.
  // Old hardcoded would give 2000 * 0.027 = $54.00 → 5400 cents.
  const out = currency.convertSubunits(2000_00, "THB", "USD");
  // THB has 2 decimals, so 2,000 baht = 200000 subunits.
  // 200000 / 100 = 2000 THB → × 0.0310 = $62.00 → × 100 = 6200 cents.
  assertEq(out, 6200, "live rate 0.031 used (was 5400 with hardcoded 0.027)");
});

test("[currency] historical date lookup uses rate from THAT day", () => {
  setupCache();
  const yesterday = m.addDays(m.today("UTC"), -1);
  // Yesterday's rate = 0.0309. 2000 THB → $61.80 → 6180 cents.
  const out = currency.convertSubunits(2000_00, "THB", "USD", yesterday);
  assertEq(out, 6180, "uses yesterday's rate (0.0309) not today's (0.0310)");
});

test("[currency] missing exact-date rate walks back up to 14 days", () => {
  setupCache();
  // 2 days ago — no exact rate; should walk back to 3-days-ago (0.0305).
  const twoDaysAgo = m.addDays(m.today("UTC"), -2);
  const out = currency.convertSubunits(2000_00, "THB", "USD", twoDaysAgo);
  assertEq(out, 6100, "walks back to 3-days-ago rate (0.0305)");
});

test("[currency] empty cache falls back to hardcoded RATES_TO_USD", () => {
  currency._testClearCache();
  const out = currency.convertSubunits(2000_00, "THB", "USD");
  // Hardcoded THB = 0.027 → 2000 * 0.027 = $54 → 5400 cents.
  assertEq(out, 5400, "hardcoded fallback when cache empty");
});

test("[currency] cache-miss for one currency falls back to hardcoded for that one", () => {
  setupCache();
  // VND not in cache (Frankfurter omits it). Should use hardcoded 0.00004.
  // 100,000 VND → 100000 * 0.00004 = $4.00 → 400 cents (USD has 2 decimals).
  const out = currency.convertSubunits(100000, "VND", "USD");
  // VND has 0 decimals so 100,000 VND = 100000 subunits = 100000 whole.
  // 100000 * 0.00004 = 4 USD = 400 cents.
  assertEq(out, 400);
});

test("[currency] same-currency conversion is identity", () => {
  setupCache();
  assertEq(currency.convertSubunits(5000, "USD", "USD"), 5000);
  assertEq(currency.convertSubunits(20000, "VND", "VND"), 20000);
});

test("[currency] getRateSource reflects cache state", () => {
  setupCache();
  assertEq(currency.getRateSource("THB"), "live");
  assertEq(currency.getRateSource("VND"), "fallback"); // not in cache
  currency._testClearCache();
  assertEq(currency.getRateSource("THB"), "fallback");
  assertEq(currency.getRateSource("USD"), "exact");
});

test("[currency] live-rate accuracy: THB $62 vs hardcoded $54 (the user-reported gap)", () => {
  // Reproduces the user's specific bug. With the live rate, 2,000 THB
  // converts to ~$62 — the actual market rate. Without it, we got $54
  // (15% drift). This test locks in the fix.
  setupCache();
  const live = currency.convertSubunits(2000_00, "THB", "USD");
  currency._testClearCache();
  const hardcoded = currency.convertSubunits(2000_00, "THB", "USD");
  assertTrue(live > hardcoded, "live rate must be higher than stale hardcoded for THB");
  assertTrue(live - hardcoded > 500, "gap is at least $5 (was $8 in real data — locks in correction)");
});
