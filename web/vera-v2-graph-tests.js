// VERA v2 -- GRAPH MEMORY + QUERY TESTS
// Tests the monthly summaries, cycle archiving, and query system.
"use strict";

// Load the engine
const v2 = require("../server/vera-v2");

let pass = 0, fail = 0, broken = [];
function assert(label, actual, expected) {
  if (actual === expected || (typeof expected === "number" && Math.abs(actual - expected) < 1)) { pass++; return; }
  fail++; broken.push(label);
  console.log("FAIL:", label, "| got:", actual, "| expected:", expected);
}
function assertTrue(l, v) { assert(l, !!v, true); }

console.log("\n========================================");
console.log("  VERA v2 -- GRAPH MEMORY + QUERY TESTS");
console.log("========================================\n");


// == SETUP ==
function makeState() {
  let s = v2.createFreshState();
  s = v2.applyAction(s, { type: "setup", data: { balanceUSD: 7000, incomeUSD: 13000, savingRate: 0.10, payday: "2026-05-25", savingsUSD: 5000 } });
  s = v2.applyAction(s, { type: "add_drain", data: { name: "Rent", amountUSD: 1237 } });
  s = v2.applyAction(s, { type: "add_drain", data: { name: "Gym", amountUSD: 55 } });
  s = v2.applyAction(s, { type: "add_pool", data: { name: "Food", type: "daily", dailyAmountUSD: 20, keywords: ["food", "lunch", "dinner", "coffee", "restaurant", "eat", "meal"] } });
  s = v2.applyAction(s, { type: "add_pool", data: { name: "Transport", type: "daily", dailyAmountUSD: 15, keywords: ["uber", "taxi", "grab", "bus", "train", "ride"] } });
  return s;
}

// == 1. MONTHLY SUMMARIES EXIST ==
console.log("-- 1. MONTHLY SUMMARIES --");
let s = makeState();
assertTrue("Fresh state has monthlySummaries", s.monthlySummaries !== undefined);
assertTrue("Fresh state monthlySummaries is object", typeof s.monthlySummaries === "object");

// Add some transactions
s = v2.applyAction(s, { type: "transaction", data: { description: "lunch food", amountUSD: 15 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 8 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "random thing", amountUSD: 25 } });

const mk = v2.monthKey(v2.today());
assertTrue("Month key exists in summaries", s.monthlySummaries[mk] !== undefined);
assertTrue("Food node exists", s.monthlySummaries[mk]["food"] !== undefined);
assertTrue("Transport node exists", s.monthlySummaries[mk]["transport"] !== undefined);
assertTrue("Total node exists", s.monthlySummaries[mk]["_total"] !== undefined);
assert("Food spent in monthly", s.monthlySummaries[mk]["food"].spent, 1500);
assert("Food count", s.monthlySummaries[mk]["food"].count, 1);
assert("Transport spent", s.monthlySummaries[mk]["transport"].spent, 800);
assert("Total spent", s.monthlySummaries[mk]["_total"].spent, 1500 + 800 + 2500);

// Add a refund
s = v2.applyAction(s, { type: "transaction", data: { description: "refund lunch food", amountUSD: -15 } });
assert("Refund reduces monthly food", s.monthlySummaries[mk]["food"].spent, 0);
assert("Refund reduces monthly total", s.monthlySummaries[mk]["_total"].spent, 800 + 2500);

// Bill payment
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Rent" } });
assertTrue("Bills node exists", s.monthlySummaries[mk]["_bills"] !== undefined);
assert("Bills amount", s.monthlySummaries[mk]["_bills"].spent, 123700);


// == 2. CYCLE HISTORY ==
console.log("\n-- 2. CYCLE ARCHIVING --");
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 50 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 20 } });
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Gym" } });

assertTrue("No cycle history yet", s.cycleHistory.length === 0);

// Income triggers cycle archive
s = v2.applyAction(s, { type: "income", data: { amountUSD: 13000, nextPayday: "2026-06-25" } });

assertTrue("Cycle archived", s.cycleHistory.length === 1);
const lastCycle = s.cycleHistory[0];
assertTrue("Cycle has start", lastCycle.cycleStart !== undefined);
assertTrue("Cycle has end", lastCycle.cycleEnd !== undefined);
assertTrue("Cycle has poolSpend", lastCycle.poolSpend !== undefined);
assert("Cycle food spend", lastCycle.poolSpend["food"], 5000);
assert("Cycle transport spend", lastCycle.poolSpend["transport"], 2000);
assertTrue("Cycle has avgDailySpend", lastCycle.avgDailySpend > 0);
assertTrue("Cycle has drainsPaid", lastCycle.drainsPaid["gym"] === 5500);

// Pool spend should be reset after income
assert("Pool food reset", s.pools["food"].spentCents, 0);
assert("Pool transport reset", s.pools["transport"].spentCents, 0);

// Income recorded in monthly
assertTrue("Income in monthly", s.monthlySummaries[mk]["_total"].earned > 0);


// == 3. QUERIES ==
console.log("\n-- 3. QUERY SYSTEM --");

// Rebuild state with transactions
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "coffee latte", amountUSD: 5 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "lunch food", amountUSD: 12 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "dinner restaurant", amountUSD: 35 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 8 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "coffee morning", amountUSD: 4.50 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "random purchase", amountUSD: 100 } });

// pool_spend query
let r = v2.runQuery(s, { type: "pool_spend", pool: "food" });
assert("Pool spend query food", r.spentCents, 500 + 1200 + 3500 + 450); // coffee, lunch, dinner, coffee2
assertTrue("Pool spend has USD", r.spentUSD !== undefined);

// month_total query
r = v2.runQuery(s, { type: "month_total" });
assert("Month total spent", r.spentCents, 500 + 1200 + 3500 + 800 + 450 + 10000);

// top_pools query
r = v2.runQuery(s, { type: "top_pools" });
assertTrue("Top pools has pools", r.pools.length > 0);
assert("Top pool is food", r.pools[0].pool, "food");

// search_spend query - search for "coffee"
r = v2.runQuery(s, { type: "search_spend", keyword: "coffee", days: 30 });
assert("Coffee search count", r.count, 2);
assert("Coffee search total", r.spentCents, 950);

// daily_average query
r = v2.runQuery(s, { type: "daily_average" });
assertTrue("Daily avg exists", r.avgCents >= 0);
assertTrue("Daily avg has USD", r.avgUSD !== undefined);

// projection query
r = v2.runQuery(s, { type: "projection" });
assertTrue("Projection has verdict", r.verdict !== undefined);
assertTrue("Projection has freeUSD", r.freeUSD !== undefined);
assertTrue("Projection has dailyBurnUSD", r.dailyBurnUSD !== undefined);

// trend query (no history yet)
r = v2.runQuery(s, { type: "trend" });
assert("Trend no history", r.trend, "no_history");

// Now add a cycle and test trend
s = v2.applyAction(s, { type: "income", data: { amountUSD: 13000, nextPayday: "2026-06-25" } });
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 15 } });
r = v2.runQuery(s, { type: "trend" });
assertTrue("Trend has direction", r.direction !== undefined);
assertTrue("Trend has pctChange", r.pctChange !== undefined);

// trend for specific pool
r = v2.runQuery(s, { type: "trend", pool: "food" });
assertTrue("Pool trend has direction", r.direction !== undefined);

// savings_history query
r = v2.runQuery(s, { type: "savings_history" });
assertTrue("Savings has current", r.currentSavingsUSD !== undefined);
assertTrue("Savings has history", r.history.length > 0);

// Unknown query
r = v2.runQuery(s, { type: "nonsense" });
assertTrue("Unknown query returns error", r.error !== undefined);

// Null query
r = v2.runQuery(s, null);
assertTrue("Null query returns error", r.error !== undefined);


// == 4. ENRICHED PICTURE ==
console.log("\n-- 4. ENRICHED PICTURE --");
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 25 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 10 } });

const pic = v2.computePicture(s);
assertTrue("Picture has cycleStats", pic.cycleStats !== undefined);
assertTrue("CycleStats has totalSpent", pic.cycleStats.totalSpent !== undefined);
assertTrue("CycleStats has dailyAvg", pic.cycleStats.dailyAvg !== undefined);
assert("CycleStats txCount", pic.cycleStats.txCount, 2);
assertTrue("Picture has monthlySnapshot", pic.monthlySnapshot !== undefined);
assertTrue("Picture has checksumOk", pic.checksumOk);


// == 5. SYSTEM PROMPT ==
console.log("\n-- 5. SYSTEM PROMPT --");
const prompt = v2.buildSystemPrompt(s);
assertTrue("Prompt includes queries", prompt.includes("QUERIES"));
assertTrue("Prompt includes pool_spend", prompt.includes("pool_spend"));
assertTrue("Prompt includes search_spend", prompt.includes("search_spend"));
assertTrue("Prompt includes projection", prompt.includes("projection"));
assertTrue("Prompt includes cycleStats", prompt.includes("cycleStats"));
assertTrue("Prompt includes NEVER calculate", prompt.includes("NEVER calculate"));


// == 6. EDGE CASES ==
console.log("\n-- 6. EDGE CASES --");

// Query on fresh state
let fresh = v2.createFreshState();
r = v2.runQuery(fresh, { type: "daily_average" });
assert("Fresh state daily avg", r.avgCents, 0);

r = v2.runQuery(fresh, { type: "month_total" });
assert("Fresh state month total", r.spentCents, 0);

r = v2.runQuery(fresh, { type: "search_spend", keyword: "anything" });
assert("Fresh state search", r.count, 0);

// Monthly summary with multiple months (simulate)
s = makeState();
s.monthlySummaries["2026-03"] = { "food": { spent: 50000, earned: 0, count: 25 }, "_total": { spent: 80000, earned: 0, count: 40 } };
r = v2.runQuery(s, { type: "pool_spend", pool: "food", month: "2026-03" });
assert("Historical month query", r.spentCents, 50000);

r = v2.runQuery(s, { type: "top_pools", month: "2026-03" });
assert("Historical top pool", r.pools[0].pool, "food");

// Cycle history cap (12 max)
s = makeState();
for (let i = 0; i < 15; i++) {
  s = v2.applyAction(s, { type: "transaction", data: { description: "test", amountUSD: 10 } });
  s = v2.applyAction(s, { type: "income", data: { amountUSD: 5000, nextPayday: "2026-06-25" } });
}
assertTrue("Cycle history capped at 12", s.cycleHistory.length <= 12);


// == RESULTS ==
console.log("\n========================================");
console.log(pass + " passed, " + fail + " failed");
if (fail === 0) {
  console.log("ALL TESTS PASSED!");
} else {
  console.log("BROKEN THINGS:");
  for (const b of broken) console.log("  x " + b);
}
if (fail > 0) process.exit(1);
