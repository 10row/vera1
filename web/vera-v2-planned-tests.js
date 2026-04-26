// VERA v2 -- PLANNED PURCHASES + TODAY TRACKING TESTS
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
console.log("  VERA v2 -- PLANNED + TODAY TESTS");
console.log("========================================\n");

function makeState() {
  let s = v2.createFreshState();
  s = v2.applyAction(s, { type: "setup", data: { balanceUSD: 7000, incomeUSD: 10000, savingRate: 0.10, payday: "2026-05-25", savingsUSD: 2000 } });
  s = v2.applyAction(s, { type: "add_drain", data: { name: "Rent", amountUSD: 1500 } });
  s = v2.applyAction(s, { type: "add_drain", data: { name: "Gym", amountUSD: 55 } });
  return s;
}

// == 1. PLANNED PURCHASES ==
console.log("-- 1. PLANNED PURCHASES --");
let s = makeState();
s = v2.applyAction(s, { type: "add_planned", data: { name: "Winter Jacket", amountUSD: 200, date: "2026-05-10" } });
assertTrue("Planned purchase exists", s.plannedPurchases["winter jacket"] !== undefined);
assert("Planned amount", s.plannedPurchases["winter jacket"].amountCents, 20000);
assert("Planned not confirmed", s.plannedPurchases["winter jacket"].confirmed, false);
assert("Planned active", s.plannedPurchases["winter jacket"].active, true);

let pic = v2.computePicture(s);
const freeWithPlanned = pic.freeRemainingTodayCents;

let s2 = v2.applyAction(s, { type: "remove_planned", data: { name: "Winter Jacket" } });
let pic2 = v2.computePicture(s2);
assertTrue("Removing planned increases free", pic2.freeRemainingTodayCents > freeWithPlanned);

s = v2.applyAction(s, { type: "confirm_planned", data: { name: "Winter Jacket" } });
assert("Confirmed", s.plannedPurchases["winter jacket"].confirmed, true);
assert("Balance reduced by 200", s.balanceCents, 700000 - 20000);
assertTrue("Transaction recorded", s.transactions.some(t => t.type === "planned_purchase"));

const balBefore = s.balanceCents;
s = v2.applyAction(s, { type: "confirm_planned", data: { name: "Winter Jacket" } });
assert("No double confirm", s.balanceCents, balBefore);

s = makeState();
s = v2.applyAction(s, { type: "add_planned", data: { name: "Trip", amountUSD: 1000 } });
s = v2.applyAction(s, { type: "add_planned", data: { name: "Laptop", amountUSD: 2000 } });
pic = v2.computePicture(s);
assertTrue("Checksum with planned", pic.checksumOk);
assertTrue("plannedPurchases in picture", pic.plannedPurchases !== undefined);
assert("2 planned items", pic.plannedPurchases.filter(p => !p.confirmed).length, 2);
assertTrue("plannedPurchasesUSD in picture", pic.plannedPurchasesUSD !== undefined);

const sBefore = JSON.stringify(s.plannedPurchases);
s = v2.applyAction(s, { type: "add_planned", data: { name: "", amountUSD: 100 } });
assert("Empty name ignored", JSON.stringify(s.plannedPurchases), sBefore);

// == 2. TODAY TRACKING ==
console.log("\n-- 2. TODAY TRACKING --");
s = makeState();
pic = v2.computePicture(s);
assertTrue("Daily pace exists", pic.dailyFreePaceUSD !== undefined);
assertTrue("Free remaining today exists", pic.freeRemainingTodayUSD !== undefined);
assertTrue("Today spent exists", pic.todaySpentUSD !== undefined);

const unalloc = v2.todayUnallocatedSpend(s);
assert("No unallocated spend yet", unalloc, 0);
assert("Free today = daily pace when no spend", pic.freeRemainingTodayUSD, pic.dailyFreePaceUSD);

s = v2.applyAction(s, { type: "transaction", data: { description: "random thing", amountUSD: 20 } });
pic = v2.computePicture(s);
assertTrue("Today spent > 0 after transaction", pic.todaySpentUSD !== "$0.00");

s = makeState();
s = v2.applyAction(s, { type: "add_pool", data: { name: "Food", type: "daily", dailyAmountUSD: 20, keywords: ["food", "lunch"] } });
s = v2.applyAction(s, { type: "transaction", data: { description: "lunch food", amountUSD: 12 } });
const todayUnalloc2 = v2.todayUnallocatedSpend(s);
assert("Pool spend not in unallocated", todayUnalloc2, 0);

// == 3. CHECKSUM INTEGRITY ==
console.log("\n-- 3. CHECKSUM INTEGRITY --");
s = makeState();
s = v2.applyAction(s, { type: "add_pool", data: { name: "Food", type: "daily", dailyAmountUSD: 25, keywords: ["food"] } });
s = v2.applyAction(s, { type: "add_pool", data: { name: "Fun", type: "monthly", allocatedUSD: 300, keywords: ["fun", "bar"] } });
s = v2.applyAction(s, { type: "add_planned", data: { name: "New Phone", amountUSD: 800 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "lunch food", amountUSD: 15 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "bar drinks", amountUSD: 40 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "random", amountUSD: 30 } });
s = v2.applyAction(s, { type: "confirm_payment", data: { name: "Gym" } });
pic = v2.computePicture(s);
assertTrue("Full waterfall checksum OK", pic.checksumOk);
assertTrue("Has planned purchases total", pic.plannedPurchasesUSD !== undefined);

s = v2.applyAction(s, { type: "confirm_planned", data: { name: "New Phone" } });
pic = v2.computePicture(s);
assertTrue("Checksum after confirm_planned", pic.checksumOk);

// == 4. PROJECTION WITH PLANNED ==
console.log("\n-- 4. PROJECTION WITH PLANNED --");
s = makeState();
s = v2.applyAction(s, { type: "add_planned", data: { name: "Trip", amountUSD: 1000 } });
s = v2.applyAction(s, { type: "transaction", data: { description: "test", amountUSD: 50 } });
const proj = v2.runQuery(s, { type: "projection" });
assertTrue("Projection accounts for planned", proj.freeCents < 700000);
assertTrue("Projection verdict exists", proj.verdict !== undefined);

// == 5. SYSTEM PROMPT ==
console.log("\n-- 5. SYSTEM PROMPT --");
s = makeState();
s = v2.applyAction(s, { type: "add_planned", data: { name: "Jacket", amountUSD: 200 } });
const prompt = v2.buildSystemPrompt(s);
assertTrue("Prompt has add_planned", prompt.includes("add_planned"));
assertTrue("Prompt has confirm_planned", prompt.includes("confirm_planned"));
assertTrue("Prompt has remove_planned", prompt.includes("remove_planned"));
assertTrue("Prompt has NEVER calculate", prompt.includes("NEVER calculate"));
assertTrue("Prompt has planned purchases", prompt.includes("Planned") || prompt.includes("planned"));

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
