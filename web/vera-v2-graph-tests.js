// VERA v2 -- GRAPH MEMORY + QUERY TESTS
"use strict";
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

function makeState() {
  let s = v2.createFreshState();
  s = v2.applyAction(s, { type: "setup", data: { balanceUSD: 7000, incomeUSD: 13000, savingRate: 0.10, payday: "2026-05-25", savingsUSD: 5000 } });
  s = v2.applyAction(s, { type: "add_drain", data: { name: "Rent", amountUSD: 1237 } });
  s = v2.applyAction(s, { type: "add_drain", data: { name: "Gym", amountUSD: 55 } });
  s = v2.applyAction(s, { type: "add_pool", data: { name: "Food", type: "daily", dailyAmountUSD: 20, keywords: ["food", "lunch", "dinner", "coffee", "restaurant", "eat", "meal"] } });
  s = v2.applyAction(s, { type: "add_pool", data: { name: "Transport", type: "daily", dailyAmountUSD: 15, keywords: ["uber", "taxi", "grab", "bus", "train", "ride"] } });
  return s;
}

// == 1. MONTHLY SUMMARIES ==
console.log("-- 1. MONTHLY SUMMARIES --");
let s = makeState();
assertTrue("Fresh state has monthlySummaries", s.monthlySummaries !== undefined);
s = v2.applyAction(s, { type: "transaction", data: { description: "lunch food", amountUSD: 15 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 8 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "random thing", amountUSD: 25 } });
const mk = v2.monthKey(v2.today());
assertTrue("Month key exists", s.monthlySummaries[mk] !== undefined);
assert("Food spent", s.monthlySummaries[mk]["food"].spent, 1500);
assert("Food count", s.monthlySummaries[mk]["food"].count, 1);
assert("Transport spent", s.monthlySummaries[mk]["transport"].spent, 800);
assert("Total spent", s.monthlySummaries[mk]["_total"].spent, 1500 + 800 + 2500);
s = v2.applyAction(s, { type: "transaction", data: { description: "refund lunch food", amountUSD: -15 } });
assert("Refund reduces food", s.monthlySummaries[mk]["food"].spent, 0);
assert("Refund reduces total", s.monthlySummaries[mk]["_total"].spent, 800 + 2500);
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Rent" } });
assertTrue("Bills node exists", s.monthlySummaries[mk]["_bills"] !== undefined);
assert("Bills amount", s.monthlySummaries[mk]["_bills"].spent, 123700);

// == 2. CYCLE ARCHIVING ==
console.log("\n-- 2. CYCLE ARCHIVING --");
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 50 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 20 } });
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Gym" } });
assertTrue("No cycle history yet", s.cycleHistory.length === 0);
s = v2.applyAction(s, { type: "income", data: { amountUSD: 13000, nextPayday: "2026-06-25" } });
assertTrue("Cycle archived", s.cycleHistory.length === 1);
const lastCycle = s.cycleHistory[0];
assertTrue("Cycle has start", lastCycle.cycleStart !== undefined);
assert("Cycle food spend", lastCycle.poolSpend["food"], 5000);
assert("Cycle transport spend", lastCycle.poolSpend["transport"], 2000);
assertTrue("Cycle has avgDailySpend", lastCycle.avgDailySpend > 0);
assertTrue("Cycle drainsPaid", lastCycle.drainsPaid["gym"] === 5500);
assert("Pool food reset", s.pools["food"].spentCents, 0);
assert("Pool transport reset", s.pools["transport"].spentCents, 0);
assertTrue("Income in monthly", s.monthlySummaries[mk]["_total"].earned > 0);

// == 3. QUERIES ==
console.log("\n-- 3. QUERY SYSTEM --");
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "coffee latte", amountUSD: 5 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "lunch food", amountUSD: 12 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "dinner restaurant", amountUSD: 35 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 8 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "coffee morning", amountUSD: 4.50 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "random purchase", amountUSD: 100 } });
let r = v2.runQuery(s, { type: "pool_spend", pool: "food" });
assert("Pool spend food", r.spentCents, 500 + 1200 + 3500 + 450);
r = v2.runQuery(s, { type: "month_total" });
assert("Month total", r.spentCents, 500 + 1200 + 3500 + 800 + 450 + 10000);
r = v2.runQuery(s, { type: "top_pools" });
assertTrue("Top pools has pools", r.pools.length > 0);
assert("Top pool is food", r.pools[0].pool, "food");
r = v2.runQuery(s, { type: "search_spend", keyword: "coffee", days: 30 });
assert("Coffee search count", r.count, 2);
assert("Coffee search total", r.spentCents, 950);
r = v2.runQuery(s, { type: "daily_average" });
assertTrue("Daily avg exists", r.avgCents >= 0);
r = v2.runQuery(s, { type: "projection" });
assertTrue("Projection has verdict", r.verdict !== undefined);
assertTrue("Projection has freeUSD", r.freeUSD !== undefined);
r = v2.runQuery(s, { type: "trend" });
assert("Trend no history", r.trend, "no_history");
s = v2.applyAction(s, { type: "income", data: { amountUSD: 13000, nextPayday: "2026-06-25" } });
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 15 } });
r = v2.runQuery(s, { type: "trend" });
assertTrue("Trend has direction", r.direction !== undefined);
r = v2.runQuery(s, { type: "trend", pool: "food" });
assertTrue("Pool trend has direction", r.direction !== undefined);
r = v2.runQuery(s, { type: "savings_history" });
assertTrue("Savings has current", r.currentSavingsUSD !== undefined);
assertTrue("Savings has history", r.history.length > 0);
r = v2.runQuery(s, { type: "nonsense" });
assertTrue("Unknown query returns error", r.error !== undefined);
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
assert("CycleStats txCount", pic.cycleStats.txCount, 2);
assertTrue("Picture has monthlySnapshot", pic.monthlySnapshot !== undefined);
assertTrue("Picture has checksumOk", pic.checksumOk);
assertTrue("Has weeklyFreePaceCents", pic.weeklyFreePaceCents !== undefined);
assert("Weekly pace = daily*7", pic.weeklyFreePaceCents, pic.dailyFreePaceCents * 7);
assertTrue("Has thisWeekSpentCents", pic.thisWeekSpentCents !== undefined);
assert("This week spent", pic.thisWeekSpentCents, 2500 + 1000);
assertTrue("Has thisMonthSpentCents", pic.thisMonthSpentCents !== undefined);
assertTrue("Has avgTransactionCents", pic.avgTransactionCents !== undefined);
assertTrue("Has upcomingBills array", Array.isArray(pic.upcomingBills));
assertTrue("Has weeklyFreePaceUSD", pic.weeklyFreePaceUSD !== undefined);
assertTrue("Has thisWeekSpentUSD", pic.thisWeekSpentUSD !== undefined);
assertTrue("Has thisMonthSpentUSD", pic.thisMonthSpentUSD !== undefined);
assertTrue("Has avgTransactionUSD", pic.avgTransactionUSD !== undefined);

// == 5. SYSTEM PROMPT ==
console.log("\n-- 5. SYSTEM PROMPT --");
const prompt = v2.buildSystemPrompt(s);
assertTrue("Prompt has STATE", prompt.includes("STATE"));
assertTrue("Prompt has setup", prompt.includes("setup"));
assertTrue("Prompt has transaction", prompt.includes("transaction"));
assertTrue("Prompt has cycleStats", prompt.includes("cycleStats"));
assertTrue("Prompt has NEVER calculate", prompt.includes("NEVER calculate"));
assertTrue("Prompt has WATERFALL", prompt.includes("WATERFALL"));
assertTrue("Prompt has weeklyPace", prompt.includes("weeklyPace"));
assertTrue("Prompt has thisWeekSpent", prompt.includes("thisWeekSpent"));
assertTrue("Prompt has thisMonthSpent", prompt.includes("thisMonthSpent"));
assertTrue("Prompt has avgTx", prompt.includes("avgTx"));

// == 6. EDGE CASES ==
console.log("\n-- 6. EDGE CASES --");
let fresh = v2.createFreshState();
r = v2.runQuery(fresh, { type: "daily_average" });
assert("Fresh daily avg", r.avgCents, 0);
r = v2.runQuery(fresh, { type: "month_total" });
assert("Fresh month total", r.spentCents, 0);
r = v2.runQuery(fresh, { type: "search_spend", keyword: "anything" });
assert("Fresh search", r.count, 0);
s = makeState();
s.monthlySummaries["2026-03"] = { "food": { spent: 50000, earned: 0, count: 25 }, "_total": { spent: 80000, earned: 0, count: 40 } };
r = v2.runQuery(s, { type: "pool_spend", pool: "food", month: "2026-03" });
assert("Historical month query", r.spentCents, 50000);
r = v2.runQuery(s, { type: "top_pools", month: "2026-03" });
assert("Historical top pool", r.pools[0].pool, "food");
s = makeState();
for (let i = 0; i < 15; i++) {
  s = v2.applyAction(s, { type: "transaction", data: { description: "test", amountUSD: 10 } });
  s = v2.applyAction(s, { type: "income", data: { amountUSD: 5000, nextPayday: "2026-06-25" } });
}
assertTrue("Cycle history capped at 12", s.cycleHistory.length <= 12);

// == 7. COMPLEX SCENARIOS ==
console.log("\n-- 7. COMPLEX SCENARIOS --");

// 7a: Full lifecycle
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "coffee", amountUSD: 5 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "uber ride", amountUSD: 12 } });
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Rent" } });
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Gym" } });
const balBefore = s.balanceCents;
s = v2.applyAction(s, { type: "income", data: { amountUSD: 13000, nextPayday: "2026-06-25" } });
assertTrue("7a: cycle archived", s.cycleHistory.length === 1);
// income 13000 -> saving 10% = 1300 saved, 11700 added
assert("7a: savings grew", s.savingsCents, 500000 + 130000);
assertTrue("7a: balance grew", s.balanceCents > balBefore);
assert("7a: pools reset", s.pools["food"].spentCents, 0);

// 7b: Refund scenario
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 50 } });
const balAfterSpend = s.balanceCents;
s = v2.applyAction(s, { type: "transaction", data: { description: "refund food lunch", amountUSD: -50 } });
assert("7b: refund restores balance", s.balanceCents, balAfterSpend + 5000);
assert("7b: pool net zero", s.pools["food"].spentCents, 0);

// 7c: Planned purchase lifecycle
s = makeState();
s = v2.applyAction(s, { type: "add_planned", data: { name: "Laptop", amountUSD: 800, date: "2026-05-01" } });
assertTrue("7c: planned exists", s.plannedPurchases["laptop"] !== undefined);
const pic2 = v2.computePicture(s);
assertTrue("7c: planned in picture", pic2.plannedPurchases.length > 0);
const balPre = s.balanceCents;
s = v2.applyAction(s, { type: "confirm_planned", data: { name: "Laptop" } });
assert("7c: balance reduced", s.balanceCents, balPre - 80000);
assertTrue("7c: confirmed", s.plannedPurchases["laptop"].confirmed);

// 7d: Savings lifecycle
s = makeState();
assert("7d: initial savings", s.savingsCents, 500000);
s = v2.applyAction(s, { type: "set_saving_rate", data: { rate: 0.20 } });
assert("7d: rate updated", s.savingRateBps, 2000);
s = v2.applyAction(s, { type: "set_savings", data: { amountUSD: 10000 } });
assert("7d: savings set", s.savingsCents, 1000000);
const balW = s.balanceCents;
s = v2.applyAction(s, { type: "withdraw_savings", data: { amountUSD: 2000, reason: "emergency" } });
assert("7d: savings after withdraw", s.savingsCents, 800000);
assert("7d: balance after withdraw", s.balanceCents, balW + 200000);

// 7e: Waterfall integrity
s = makeState();
s = v2.applyAction(s, { type: "add_planned", data: { name: "TV", amountUSD: 500 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "food lunch", amountUSD: 30 } });
const pic3 = v2.computePicture(s);
const wSum = pic3.billsReservedCents + pic3.plannedTotalCents + pic3.poolReserveCents + pic3.trulyFreeCents;
assert("7e: waterfall = balance", wSum, pic3.balanceCents);
assertTrue("7e: checksum ok", pic3.checksumOk);

// 7f: Setup guard — no payday means no setup
fresh = v2.createFreshState();
fresh = v2.applyAction(fresh, { type: "setup", data: { balanceUSD: 5000, incomeUSD: 10000 } });
assert("7f: no payday no setup", fresh.setup, false);

// 7g: Reset clears everything
s = makeState();
s = v2.applyAction(s, { type: "transaction", data: { description: "food", amountUSD: 20 } });
s = v2.applyAction(s, { type: "reset", data: {} });
assert("7g: reset setup", s.setup, false);
assert("7g: reset balance", s.balanceCents, 0);
assert("7g: reset transactions", s.transactions.length, 0);
assertTrue("7g: reset drains empty", Object.keys(s.drains).length === 0);

// == RESULTS ==
console.log("\n========================================");
console.log("  RESULTS: " + pass + " passed, " + fail + " failed");
if (broken.length) console.log("  BROKEN:", broken.join(", "));
console.log("========================================\n");
process.exit(fail > 0 ? 1 : 0);
