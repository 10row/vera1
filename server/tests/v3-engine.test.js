"use strict";
// v3-engine.test.js — Comprehensive tests for vera-v3 engine
// Run: node server/tests/v3-engine.test.js

const assert = require("assert");
const path = require("path");

// Require modules under test
const v3 = require(path.join(__dirname, "..", "vera-v3"));
const { computePicture } = require(path.join(__dirname, "..", "vera-v3-picture"));
const { buildSystemPrompt } = require(path.join(__dirname, "..", "system-prompt"));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("\x1b[32m  ✓\x1b[0m " + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log("\x1b[31m  ✗\x1b[0m " + name);
    console.log("    " + err.message);
  }
}

function setupState(overrides) {
  let s = v3.createFreshState();
  s = v3.applyAction(s, {
    type: "setup",
    data: { balanceUSD: 1000, payday: futureDate(30) },
  });
  if (overrides) {
    Object.assign(s, overrides);
  }
  return s;
}

function futureDate(days) {
  const d = new Date(v3.today() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pastDate(days) {
  const d = new Date(v3.today() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Core Utilities ---");

test("toCents: $1,234.56 -> 123456", () => {
  assert.strictEqual(v3.toCents("$1,234.56"), 123456);
});

test("toCents: '0' -> 0", () => {
  assert.strictEqual(v3.toCents("0"), 0);
});

test("toCents: negative number -5.50 -> -550", () => {
  assert.strictEqual(v3.toCents(-5.50), -550);
});

test("toCents: null -> 0", () => {
  assert.strictEqual(v3.toCents(null), 0);
});

test("toCents: undefined -> 0", () => {
  assert.strictEqual(v3.toCents(undefined), 0);
});

test("toCents: NaN string -> 0", () => {
  assert.strictEqual(v3.toCents("abc"), 0);
});

test("toCents: plain number 42 -> 4200", () => {
  assert.strictEqual(v3.toCents(42), 4200);
});

test("toCents: Infinity -> 0", () => {
  assert.strictEqual(v3.toCents(Infinity), 0);
});

test("toMoney: 123456 -> contains $, 1234, .56", () => {
  const result = v3.toMoney(123456);
  assert.ok(result.startsWith("$"), "Should start with $, got: " + result);
  assert.ok(result.endsWith(".56"), "Should end with .56, got: " + result);
  assert.ok(result.includes("1") && result.includes("234"), "Should contain 1234, got: " + result);
});

test("toMoney: 0 -> '$0.00'", () => {
  assert.strictEqual(v3.toMoney(0), "$0.00");
});

test("toMoney: negative -550 -> '-$5.50'", () => {
  assert.strictEqual(v3.toMoney(-550), "-$5.50");
});

test("toMoney: null -> '$0.00'", () => {
  assert.strictEqual(v3.toMoney(null), "$0.00");
});

test("toMoney: custom symbol", () => {
  const result = v3.toMoney(12345, "₽");
  assert.ok(result.startsWith("₽") || result.startsWith("-₽"));
  assert.ok(result.includes("123"));
});

test("today: returns YYYY-MM-DD format", () => {
  const t = v3.today();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(t), "today() should return YYYY-MM-DD, got: " + t);
});

test("daysUntil: future date returns positive", () => {
  const future = futureDate(10);
  const result = v3.daysUntil(future);
  assert.ok(result >= 9 && result <= 11, "Expected ~10, got: " + result);
});

test("daysUntil: past date returns 1 (min clamped)", () => {
  const past = pastDate(5);
  const result = v3.daysUntil(past);
  assert.strictEqual(result, 1);
});

test("daysUntil: today returns 1 (min clamped)", () => {
  const result = v3.daysUntil(v3.today());
  assert.strictEqual(result, 1);
});

test("daysUntil: null returns 30 (default)", () => {
  assert.strictEqual(v3.daysUntil(null), 30);
});

test("daysUntil: accepts timezone parameter without error", () => {
  const future = futureDate(5);
  const result = v3.daysUntil(future, "America/New_York");
  assert.ok(result >= 4 && result <= 6, "Expected ~5, got: " + result);
});

test("daysUntil: invalid timezone falls back gracefully", () => {
  const future = futureDate(5);
  const result = v3.daysUntil(future, "Invalid/Zone");
  assert.ok(result >= 4 && result <= 6, "Expected ~5, got: " + result);
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- State Management ---");

test("createFreshState: returns valid initial state", () => {
  const s = v3.createFreshState();
  assert.strictEqual(s.setup, false);
  assert.strictEqual(s.balanceCents, 0);
  assert.strictEqual(s.currency, "USD");
  assert.strictEqual(s.currencySymbol, "$");
  assert.strictEqual(s.language, "en");
  assert.strictEqual(s.payday, null);
  assert.strictEqual(s.cycleStart, null);
  assert.deepStrictEqual(s.envelopes, {});
  assert.ok(Array.isArray(s.transactions));
  assert.ok(Array.isArray(s.conversationHistory));
  assert.deepStrictEqual(s.monthlySummaries, {});
  assert.ok(Array.isArray(s.cycleHistory));
  assert.strictEqual(s.undoSnapshot, null);
});

test("applyAction setup: sets balance, payday, marks setup=true", () => {
  const s = v3.applyAction(v3.createFreshState(), {
    type: "setup",
    data: { balanceUSD: 500, payday: futureDate(15) },
  });
  assert.strictEqual(s.setup, true);
  assert.strictEqual(s.balanceCents, 50000);
  assert.ok(s.payday != null, "payday should be set");
  assert.strictEqual(s.cycleStart, v3.today());
  assert.strictEqual(s.transactions.length, 1);
  assert.strictEqual(s.transactions[0].type, "setup");
});

test("applyAction setup without payday: defaults to ~30 days out", () => {
  const s = v3.applyAction(v3.createFreshState(), {
    type: "setup",
    data: { balanceUSD: 100 },
  });
  assert.strictEqual(s.setup, true);
  assert.ok(s.payday != null, "payday should default");
  const dl = v3.daysUntil(s.payday);
  assert.ok(dl >= 29 && dl <= 31, "Should default to ~30 days, got: " + dl);
});

test("applyAction setup with currency", () => {
  const s = v3.applyAction(v3.createFreshState(), {
    type: "setup",
    data: { balanceUSD: 100, currency: "RUB", symbol: "₽" },
  });
  assert.strictEqual(s.currency, "RUB");
  assert.strictEqual(s.currencySymbol, "₽");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Spending ---");

test("spend free (no envelope match): deducts from balance, adds transaction", () => {
  const s = setupState();
  const after = v3.applyAction(s, {
    type: "spend",
    data: { amountUSD: 25, description: "lunch" },
  });
  assert.strictEqual(after.balanceCents, 100000 - 2500);
  const tx = after.transactions.find(t => t.type === "spend" && t.description === "lunch");
  assert.ok(tx, "Should have a spend transaction");
  assert.strictEqual(tx.amountCents, 2500);
  assert.strictEqual(tx.envelope, "free");
});

test("spend matched to envelope: deducts balance, increments envelope spentCents", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Coffee", amountUSD: 5, rhythm: "daily", keywords: ["coffee", "cafe"] },
  });
  const after = v3.applyAction(s, {
    type: "spend",
    data: { amountUSD: 4.50, description: "morning coffee" },
  });
  assert.strictEqual(after.balanceCents, 100000 - 450);
  assert.strictEqual(after.envelopes.coffee.spentCents, 450);
});

test("spend with negative amount (refund): adds to balance", () => {
  const s = setupState();
  const after = v3.applyAction(s, {
    type: "spend",
    data: { amountUSD: -20, description: "refund" },
  });
  assert.strictEqual(after.balanceCents, 100000 + 2000);
  const tx = after.transactions.find(t => t.type === "refund");
  assert.ok(tx, "Should create a refund transaction");
});

test("spend more than balance: goes negative", () => {
  const s = setupState();
  const after = v3.applyAction(s, {
    type: "spend",
    data: { amountUSD: 2000, description: "big purchase" },
  });
  assert.strictEqual(after.balanceCents, 100000 - 200000);
  assert.ok(after.balanceCents < 0, "Balance should be negative");
});

test("spend zero: no-op (returns unchanged state)", () => {
  const s = setupState();
  const txCount = s.transactions.length;
  const after = v3.applyAction(s, {
    type: "spend",
    data: { amountUSD: 0, description: "nothing" },
  });
  assert.strictEqual(after.balanceCents, s.balanceCents);
  assert.strictEqual(after.transactions.length, txCount);
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Envelopes ---");

test("create_envelope: creates with correct key, rhythm, amount", () => {
  const s = setupState();
  const after = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Groceries", amountUSD: 100, rhythm: "weekly" },
  });
  assert.ok(after.envelopes.groceries, "Envelope should exist");
  assert.strictEqual(after.envelopes.groceries.name, "Groceries");
  assert.strictEqual(after.envelopes.groceries.amountCents, 10000);
  assert.strictEqual(after.envelopes.groceries.rhythm, "weekly");
  assert.strictEqual(after.envelopes.groceries.active, true);
  assert.strictEqual(after.envelopes.groceries.spentCents, 0);
});

test("create_envelope with keywords: stores keywords array", () => {
  const s = setupState();
  const after = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Food", amountUSD: 50, rhythm: "weekly", keywords: ["grocery", "food", "walmart"] },
  });
  assert.deepStrictEqual(after.envelopes.food.keywords, ["grocery", "food", "walmart"]);
});

test("create_envelope with target (savings goal): sets targetCents", () => {
  const s = setupState();
  const after = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Vacation", amountUSD: 0, rhythm: "ongoing", targetUSD: 3000 },
  });
  assert.strictEqual(after.envelopes.vacation.targetCents, 300000);
  assert.strictEqual(after.envelopes.vacation.rhythm, "ongoing");
});

test("update_envelope: changes fields", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Rent", amountUSD: 1000, rhythm: "monthly" },
  });
  const after = v3.applyAction(s, {
    type: "update_envelope",
    data: { name: "Rent", amountUSD: 1200, priority: "essential" },
  });
  assert.strictEqual(after.envelopes.rent.amountCents, 120000);
  assert.strictEqual(after.envelopes.rent.priority, "essential");
});

test("remove_envelope: sets active=false", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Netflix", amountUSD: 15, rhythm: "monthly" },
  });
  const after = v3.applyAction(s, {
    type: "remove_envelope",
    data: { name: "Netflix" },
  });
  assert.strictEqual(after.envelopes.netflix.active, false);
});

test("pay_envelope: deducts amountCents from balance, marks as paid, advances nextDate", () => {
  let s = setupState();
  const nextDate = futureDate(5);
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Rent", amountUSD: 1400, rhythm: "monthly", nextDate, intervalDays: 30 },
  });
  const balBefore = s.balanceCents;
  const after = v3.applyAction(s, {
    type: "pay_envelope",
    data: { name: "Rent" },
  });
  assert.strictEqual(after.balanceCents, balBefore - 140000);
  assert.strictEqual(after.envelopes.rent.spentCents, 140000);
  // nextDate should advance by intervalDays
  assert.ok(after.envelopes.rent.nextDate > nextDate, "nextDate should advance");
  const tx = after.transactions.find(t => t.type === "envelope_payment" && t.envelope === "rent");
  assert.ok(tx, "Should have envelope_payment transaction");
});

test("skip_envelope: advances nextDate without spending", () => {
  let s = setupState();
  const nextDate = futureDate(2);
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Gym", amountUSD: 30, rhythm: "monthly", nextDate, intervalDays: 30 },
  });
  const balBefore = s.balanceCents;
  const after = v3.applyAction(s, {
    type: "skip_envelope",
    data: { name: "Gym" },
  });
  assert.strictEqual(after.balanceCents, balBefore, "Balance should not change");
  assert.ok(after.envelopes.gym.nextDate > nextDate, "nextDate should advance");
  assert.strictEqual(after.envelopes.gym.spentCents, 0, "spentCents should remain 0");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Income ---");

test("income: adds to balance, resets budget envelope spentCents, advances payday", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Coffee", amountUSD: 5, rhythm: "daily", keywords: ["coffee"] },
  });
  s = v3.applyAction(s, {
    type: "spend",
    data: { amountUSD: 3, description: "coffee" },
  });
  assert.strictEqual(s.envelopes.coffee.spentCents, 300);
  const balBefore = s.balanceCents;
  const nextPayday = futureDate(30);
  const after = v3.applyAction(s, {
    type: "income",
    data: { amountUSD: 2000, nextPayday },
  });
  assert.strictEqual(after.balanceCents, balBefore + 200000);
  assert.strictEqual(after.envelopes.coffee.spentCents, 0, "Budget envelope spentCents should reset");
  assert.strictEqual(after.cycleStart, v3.today());
  const incomeTx = after.transactions.find(t => t.type === "income");
  assert.ok(incomeTx, "Should have income transaction");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- The Equation: balance = reserves + free ---");

function checkEquation(s, label) {
  const pic = computePicture(s);
  if (!pic.setup) return; // skip non-setup states
  const lhs = pic.balanceCents;
  const rhs = pic.totalReservedCents + pic.freeCents;
  assert.strictEqual(lhs, rhs,
    `${label}: balance (${lhs}) != reserves (${pic.totalReservedCents}) + free (${pic.freeCents})`);
  assert.strictEqual(pic.checksumOk, true, label + ": checksumOk should be true");
}

test("Equation: after setup", () => {
  const s = setupState();
  checkEquation(s, "after setup");
});

test("Equation: after spending", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 50, description: "stuff" } });
  checkEquation(s, "after spending");
});

test("Equation: after creating envelope", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Rent", amountUSD: 500, rhythm: "monthly" },
  });
  checkEquation(s, "after creating envelope");
});

test("Equation: after paying envelope", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Phone", amountUSD: 80, rhythm: "monthly", nextDate: futureDate(10) },
  });
  s = v3.applyAction(s, { type: "pay_envelope", data: { name: "Phone" } });
  checkEquation(s, "after paying envelope");
});

test("Equation: after income", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Food", amountUSD: 200, rhythm: "monthly" },
  });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 100, description: "groceries" } });
  s = v3.applyAction(s, { type: "income", data: { amountUSD: 3000, nextPayday: futureDate(30) } });
  checkEquation(s, "after income");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Reset and Undo ---");

test("reset: returns fresh state", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 50, description: "x" } });
  const after = v3.applyAction(s, { type: "reset" });
  assert.strictEqual(after.setup, false);
  assert.strictEqual(after.balanceCents, 0);
  assert.deepStrictEqual(after.envelopes, {});
  assert.strictEqual(after.transactions.length, 0);
});

test("undo: restores undoSnapshot if present", () => {
  let s = setupState();
  // Simulate what telegram-v3 does: save undoSnapshot before action
  s.undoSnapshot = JSON.parse(JSON.stringify(s));
  delete s.undoSnapshot.undoSnapshot;
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 50, description: "oops" } });
  // Now undo
  const undone = v3.applyAction(s, { type: "undo" });
  assert.strictEqual(undone.balanceCents, 100000, "Should restore to pre-spend balance");
});

test("undo: no snapshot returns same state", () => {
  const s = setupState();
  s.undoSnapshot = null;
  const after = v3.applyAction(s, { type: "undo" });
  assert.strictEqual(after.balanceCents, s.balanceCents);
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Edge Cases ---");

test("Multiple actions in sequence: setup + create_envelope + create_envelope", () => {
  let s = v3.createFreshState();
  s = v3.applyAction(s, { type: "setup", data: { balanceUSD: 2000, payday: futureDate(14) } });
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Rent", amountUSD: 1000, rhythm: "monthly" } });
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Food", amountUSD: 200, rhythm: "weekly" } });
  assert.strictEqual(s.setup, true);
  assert.strictEqual(s.balanceCents, 200000);
  assert.ok(s.envelopes.rent, "Rent envelope should exist");
  assert.ok(s.envelopes.food, "Food envelope should exist");
  assert.strictEqual(Object.keys(s.envelopes).length, 2);
  checkEquation(s, "multi-action");
});

test("Very large amounts (millions of cents)", () => {
  let s = v3.createFreshState();
  s = v3.applyAction(s, { type: "setup", data: { balanceUSD: 1000000 } });
  assert.strictEqual(s.balanceCents, 100000000);
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 500000, description: "house" } });
  assert.strictEqual(s.balanceCents, 50000000);
  const formatted = v3.toMoney(s.balanceCents);
  assert.ok(formatted.includes("500") && formatted.includes("000"), "Should format large number: " + formatted);
});

test("Unicode envelope names", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Квартира", amountUSD: 500, rhythm: "monthly" },
  });
  const key = v3.ekey("Квартира");
  assert.ok(s.envelopes[key], "Unicode envelope should exist with key: " + key);
  assert.strictEqual(s.envelopes[key].name, "Квартира");
});

test("Duplicate envelope names (same key) overwrites", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Food", amountUSD: 100, rhythm: "weekly" },
  });
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Food", amountUSD: 200, rhythm: "monthly" },
  });
  assert.strictEqual(Object.keys(s.envelopes).filter(k => k === "food").length, 1);
  assert.strictEqual(s.envelopes.food.amountCents, 20000, "Second create should overwrite");
  assert.strictEqual(s.envelopes.food.rhythm, "monthly");
});

test("applyAction with null action: returns state unchanged", () => {
  const s = setupState();
  const after = v3.applyAction(s, null);
  assert.strictEqual(after.balanceCents, s.balanceCents);
});

test("applyAction with unknown type: returns state unchanged", () => {
  const s = setupState();
  const after = v3.applyAction(s, { type: "bogus", data: {} });
  assert.strictEqual(after.balanceCents, s.balanceCents);
});

test("matchEnvelope: matches by keyword", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Coffee", amountUSD: 5, rhythm: "daily", keywords: ["coffee", "starbucks", "cafe"] },
  });
  assert.strictEqual(v3.matchEnvelope(s, "starbucks latte"), "coffee");
  assert.strictEqual(v3.matchEnvelope(s, "pizza"), null);
});

test("matchEnvelope: longest keyword wins", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Food", amountUSD: 100, rhythm: "weekly", keywords: ["food"] },
  });
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Fast Food", amountUSD: 50, rhythm: "weekly", keywords: ["fast food"] },
  });
  assert.strictEqual(v3.matchEnvelope(s, "fast food burger"), "fast_food");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- System Prompt ---");

test("buildSystemPrompt returns a string", () => {
  const s = v3.createFreshState();
  const prompt = buildSystemPrompt(s);
  assert.strictEqual(typeof prompt, "string");
  assert.ok(prompt.length > 100, "Should be a substantial prompt");
});

test("buildSystemPrompt contains 'SpendYes'", () => {
  const prompt = buildSystemPrompt(v3.createFreshState());
  assert.ok(prompt.includes("SpendYes"), "Should mention SpendYes");
});

test("buildSystemPrompt contains state data when setup=true", () => {
  const s = setupState();
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes('"setup":true'), "Should include setup:true in state");
  assert.ok(prompt.includes("1,000") || prompt.includes("1000"), "Should include formatted balance");
});

test("buildSystemPrompt contains 'FOLLOW UP ABOUT BILLS' section", () => {
  const prompt = buildSystemPrompt(v3.createFreshState());
  assert.ok(prompt.includes("FOLLOW UP ABOUT BILLS"), "Should have FOLLOW UP ABOUT BILLS");
});

test("buildSystemPrompt contains voice-first instructions", () => {
  const prompt = buildSystemPrompt(v3.createFreshState());
  assert.ok(prompt.includes("VOICE-FIRST"), "Should mention VOICE-FIRST");
  assert.ok(prompt.includes("voice"), "Should mention voice");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- computePicture ---");

test("computePicture: returns correct freeRemainingTodayCents", () => {
  const s = setupState();
  const pic = computePicture(s);
  assert.ok(pic.setup, "Should be setup");
  assert.ok(typeof pic.freeRemainingTodayCents === "number", "Should have freeRemainingTodayCents");
  // freeToday = dailyPace - todayUnmatched, with no spending today it equals dailyPace
  assert.strictEqual(pic.freeRemainingTodayCents, pic.dailyPaceCents);
});

test("computePicture: returns correct dailyPaceCents", () => {
  const s = setupState();
  const pic = computePicture(s);
  const expectedDailyPace = Math.floor(pic.freeCents / pic.daysLeft);
  assert.strictEqual(pic.dailyPaceCents, expectedDailyPace);
});

test("computePicture: returns dueEnvelopes for overdue items", () => {
  let s = setupState();
  const pastD = pastDate(2);
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Phone Bill", amountUSD: 60, rhythm: "monthly", nextDate: pastD },
  });
  const pic = computePicture(s);
  assert.ok(pic.dueEnvelopes.length > 0, "Should have due envelopes");
  assert.strictEqual(pic.dueEnvelopes[0].name, "Phone Bill");
});

test("computePicture: handles non-setup state gracefully", () => {
  const s = v3.createFreshState();
  const pic = computePicture(s);
  assert.strictEqual(pic.setup, false);
  assert.strictEqual(pic.balanceCents, undefined);
});

test("computePicture: checksumOk is true (equation holds)", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Rent", amountUSD: 400, rhythm: "monthly" },
  });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 30, description: "taxi" } });
  const pic = computePicture(s);
  assert.strictEqual(pic.checksumOk, true);
  assert.strictEqual(pic.balanceCents, pic.totalReservedCents + pic.freeCents);
});

test("computePicture: envelopes list populated correctly", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Gym", amountUSD: 30, rhythm: "monthly" },
  });
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Netflix", amountUSD: 15, rhythm: "monthly" },
  });
  const pic = computePicture(s);
  assert.strictEqual(pic.envelopes.length, 2);
  const names = pic.envelopes.map(e => e.name).sort();
  assert.deepStrictEqual(names, ["Gym", "Netflix"]);
});

test("computePicture: inactive envelopes excluded", () => {
  let s = setupState();
  s = v3.applyAction(s, {
    type: "create_envelope",
    data: { name: "Old", amountUSD: 50, rhythm: "monthly" },
  });
  s = v3.applyAction(s, { type: "remove_envelope", data: { name: "Old" } });
  const pic = computePicture(s);
  assert.strictEqual(pic.envelopes.length, 0);
});

test("computePicture: todaySpentFormatted is present", () => {
  const s = v3.createFreshState(); s.setup = true; s.balanceCents = 100000; s.payday = futureDate(30);
  s.transactions.push({ id: "ts1", type: "spend", amountCents: 500, description: "test", envelope: "free", date: v3.today(), ts: Date.now() });
  const pic = computePicture(s);
  assert.ok(pic.todaySpentFormatted, "todaySpentFormatted should be present");
  assert.ok(pic.todaySpentFormatted.includes("5"), "todaySpentFormatted should include $5.00");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Timezone ---");

test("today() with no args returns YYYY-MM-DD (UTC)", () => {
  const t = v3.today();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(t));
});

test("today() with valid IANA timezone returns YYYY-MM-DD", () => {
  const t = v3.today("America/New_York");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(t), "Should return YYYY-MM-DD, got: " + t);
});

test("today() with invalid timezone falls back to UTC", () => {
  const t = v3.today("Invalid/Zone");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(t), "Should return YYYY-MM-DD even for invalid tz, got: " + t);
});

test("setup with timezone stores it in state", () => {
  const s = v3.applyAction(v3.createFreshState(), {
    type: "setup",
    data: { balanceUSD: 1000, timezone: "Europe/London" },
  });
  assert.strictEqual(s.timezone, "Europe/London");
});

test("createFreshState includes timezone: UTC", () => {
  const s = v3.createFreshState();
  assert.strictEqual(s.timezone, "UTC");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Edit Spend ---");

test("edit_spend: changes amount and adjusts balance", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 40, description: "coffee" } });
  const txId = s.transactions.find(t => t.type === "spend" && t.description === "coffee").id;
  const balAfterSpend = s.balanceCents; // 100000 - 4000 = 96000
  const after = v3.applyAction(s, { type: "edit_spend", data: { txId, newAmountUSD: 14 } });
  // Balance should be: original 100000 - 1400 = 98600
  assert.strictEqual(after.balanceCents, 100000 - 1400);
  const editedTx = after.transactions.find(t => t.id === txId);
  assert.strictEqual(editedTx.amountCents, 1400);
});

test("edit_spend: changes description", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 10, description: "taxi" } });
  const txId = s.transactions.find(t => t.type === "spend" && t.description === "taxi").id;
  const after = v3.applyAction(s, { type: "edit_spend", data: { txId, newDescription: "uber" } });
  assert.strictEqual(after.transactions.find(t => t.id === txId).description, "uber");
});

test("edit_spend: adjusts envelope spentCents", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Coffee", amountUSD: 10, rhythm: "daily", keywords: ["coffee"] } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 8, description: "coffee latte" } });
  assert.strictEqual(s.envelopes.coffee.spentCents, 800);
  const txId = s.transactions.find(t => t.type === "spend" && t.description === "coffee latte").id;
  const after = v3.applyAction(s, { type: "edit_spend", data: { txId, newAmountUSD: 4 } });
  assert.strictEqual(after.envelopes.coffee.spentCents, 400);
});

test("edit_spend: invalid txId returns state unchanged", () => {
  const s = setupState();
  const after = v3.applyAction(s, { type: "edit_spend", data: { txId: "nonexistent", newAmountUSD: 5 } });
  assert.strictEqual(after.balanceCents, s.balanceCents);
});

test("edit_spend: equation holds after edit", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Food", amountUSD: 100, rhythm: "weekly" } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 30, description: "lunch" } });
  const txId = s.transactions.find(t => t.description === "lunch").id;
  s = v3.applyAction(s, { type: "edit_spend", data: { txId, newAmountUSD: 15 } });
  checkEquation(s, "after edit_spend");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Delete Spend ---");

test("delete_spend: removes transaction and restores balance", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 25, description: "movie" } });
  const txId = s.transactions.find(t => t.description === "movie").id;
  const txCountBefore = s.transactions.length;
  const after = v3.applyAction(s, { type: "delete_spend", data: { txId } });
  assert.strictEqual(after.balanceCents, 100000, "Balance should be fully restored");
  assert.strictEqual(after.transactions.length, txCountBefore - 1);
  assert.ok(!after.transactions.find(t => t.id === txId), "Transaction should be gone");
});

test("delete_spend: restores envelope spentCents", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Food", amountUSD: 50, rhythm: "daily", keywords: ["food"] } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 20, description: "food court" } });
  assert.strictEqual(s.envelopes.food.spentCents, 2000);
  const txId = s.transactions.find(t => t.description === "food court").id;
  const after = v3.applyAction(s, { type: "delete_spend", data: { txId } });
  assert.strictEqual(after.envelopes.food.spentCents, 0);
});

test("delete_spend: refuses to delete income transaction", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "income", data: { amountUSD: 2000, nextPayday: futureDate(30) } });
  const incomeTx = s.transactions.find(t => t.type === "income");
  const after = v3.applyAction(s, { type: "delete_spend", data: { txId: incomeTx.id } });
  assert.ok(after.transactions.find(t => t.id === incomeTx.id), "Income tx should NOT be deleted");
});

test("delete_spend: invalid txId returns state unchanged", () => {
  const s = setupState();
  const after = v3.applyAction(s, { type: "delete_spend", data: { txId: "bogus" } });
  assert.strictEqual(after.balanceCents, s.balanceCents);
});

test("delete_spend: equation holds after delete", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Gym", amountUSD: 30, rhythm: "monthly" } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 50, description: "shoes" } });
  const txId = s.transactions.find(t => t.description === "shoes").id;
  s = v3.applyAction(s, { type: "delete_spend", data: { txId } });
  checkEquation(s, "after delete_spend");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Insights in System Prompt ---");

test("buildSystemPrompt includes insights when budget is overspent", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Coffee", amountUSD: 5, rhythm: "daily" } });
  // Spend more than the daily budget
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 8, description: "coffee", envelope: "coffee" } });
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("insights") || prompt.includes("over budget") || prompt.includes("100%"),
    "Should include budget warning insight");
});

test("buildSystemPrompt includes recentTx with transaction IDs", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 10, description: "lunch" } });
  const prompt = buildSystemPrompt(s);
  const txId = s.transactions.find(t => t.description === "lunch").id;
  assert.ok(prompt.includes(txId), "Prompt should contain transaction ID for edit/delete");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Native Language (Russian) ---");

test("buildSystemPrompt: Russian user gets native Russian prompt", () => {
  let s = setupState();
  s.language = "ru";
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("Russian"), "Should declare Russian language");
  assert.ok(prompt.includes("Зажми микрофон"), "Should have native Russian setup greeting");
  assert.ok(prompt.includes("зарплата пришла"), "Should have native Russian income example");
  assert.ok(prompt.includes("удали последнее"), "Should have native Russian correction example");
  assert.ok(prompt.includes("Сегодня:"), "Should have Russian hero number format");
  assert.ok(!prompt.includes("Got it. Oh heads up"), "Should NOT have English nudge examples");
});

test("buildSystemPrompt: English user gets English prompt", () => {
  let s = setupState();
  s.language = "en";
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("English"), "Should declare English language");
  assert.ok(prompt.includes("Just hold the mic"), "Should have English setup greeting");
  assert.ok(prompt.includes("got paid"), "Should have English income example");
  assert.ok(!prompt.includes("Зажми микрофон"), "Should NOT have Russian text");
});

test("buildSystemPrompt: Russian insights are in Russian", () => {
  let s = setupState();
  s.language = "ru";
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Кофе", amountUSD: 5, rhythm: "daily" } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 8, description: "кофе", envelope: "кофе" } });
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("перерасход") || prompt.includes("100%"), "Russian insight should use native text");
});

test("buildSystemPrompt: Russian slang glossary present for RU users", () => {
  let s = setupState();
  s.language = "ru";
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("тыщ"), "Should include тыщ slang mapping");
  assert.ok(prompt.includes("косарь"), "Should include косарь slang mapping");
  assert.ok(prompt.includes("штука"), "Should include штука slang mapping");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- update_settings ---");

test("update_settings: changes timezone without touching balance", () => {
  let s = setupState();
  const balBefore = s.balanceCents;
  const txCountBefore = s.transactions.length;
  s = v3.applyAction(s, { type: "update_settings", data: { timezone: "Europe/Moscow" } });
  assert.strictEqual(s.timezone, "Europe/Moscow");
  assert.strictEqual(s.balanceCents, balBefore, "Balance should not change");
  assert.strictEqual(s.transactions.length, txCountBefore, "No new transactions");
});

test("update_settings: changes currency and symbol", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "update_settings", data: { currency: "EUR", symbol: "€" } });
  assert.strictEqual(s.currency, "EUR");
  assert.strictEqual(s.currencySymbol, "€");
});

test("update_settings: changes payday", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "update_settings", data: { payday: futureDate(25) } });
  assert.strictEqual(s.payday, futureDate(25));
});

test("update_settings: changes language", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "update_settings", data: { language: "ru" } });
  assert.strictEqual(s.language, "ru");
});

test("update_settings: partial — only changes provided fields", () => {
  let s = setupState();
  s.timezone = "UTC";
  s.currency = "USD";
  s = v3.applyAction(s, { type: "update_settings", data: { timezone: "Asia/Tokyo" } });
  assert.strictEqual(s.timezone, "Asia/Tokyo");
  assert.strictEqual(s.currency, "USD", "Currency should remain unchanged");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- rename_envelope ---");

test("rename_envelope: renames key and updates transactions", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Groceries", amountUSD: 100, rhythm: "weekly" } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 30, description: "supermarket", envelope: "groceries" } });
  assert.ok(s.envelopes["groceries"], "Old key should exist before rename");
  s = v3.applyAction(s, { type: "rename_envelope", data: { oldName: "Groceries", newName: "Food" } });
  assert.ok(!s.envelopes["groceries"], "Old key should be gone");
  assert.ok(s.envelopes["food"], "New key should exist");
  assert.strictEqual(s.envelopes["food"].name, "Food");
  // Transaction should be updated
  const tx = s.transactions.find(t => t.description === "supermarket");
  assert.strictEqual(tx.envelope, "food", "Transaction envelope should be updated to new key");
});

test("rename_envelope: same key does not break (just updates display name)", () => {
  let s = setupState();
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Coffee", amountUSD: 5, rhythm: "daily" } });
  s = v3.applyAction(s, { type: "rename_envelope", data: { oldName: "Coffee", newName: "coffee" } });
  assert.ok(s.envelopes["coffee"], "Key should still exist");
});

test("rename_envelope: nonexistent envelope returns state unchanged", () => {
  let s = setupState();
  const before = JSON.stringify(s);
  s = v3.applyAction(s, { type: "rename_envelope", data: { oldName: "nope", newName: "also nope" } });
  assert.strictEqual(JSON.stringify(s), before);
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- System Prompt: update_settings ---");

test("buildSystemPrompt includes update_settings in actions list", () => {
  const s = setupState();
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("update_settings"), "Should list update_settings action");
  assert.ok(prompt.includes("rename_envelope"), "Should list rename_envelope action");
});

test("buildSystemPrompt includes adjustment examples", () => {
  const s = setupState();
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("ADJUSTMENTS"), "Should have adjustments section");
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Cycle / Payday Logic ---");

test("advancePayday: monthly advances to next month same day", () => {
  const past = pastDate(5);
  const result = v3.advancePayday(past, "monthly");
  const todayMs = new Date(v3.today() + "T00:00:00Z");
  const rd = new Date(result + "T00:00:00Z");
  const pd = new Date(past + "T00:00:00Z");
  assert.ok(rd > todayMs, "Should be in the future, got: " + result);
  assert.strictEqual(rd.getUTCDate(), pd.getUTCDate(), "Day of month should be same");
});

test("advancePayday: biweekly advances by 14 days", () => {
  const past = pastDate(3);
  const result = v3.advancePayday(past, "biweekly");
  const todayMs = new Date(v3.today() + "T00:00:00Z");
  const rd = new Date(result + "T00:00:00Z");
  assert.ok(rd > todayMs, "Should be in the future");
  const daysOut = Math.round((rd - todayMs) / 86400000);
  assert.ok(daysOut >= 10 && daysOut <= 12, "Should be ~11 days out, got: " + daysOut);
});

test("advancePayday: weekly advances by 7 days", () => {
  const past = pastDate(2);
  const result = v3.advancePayday(past, "weekly");
  const todayMs = new Date(v3.today() + "T00:00:00Z");
  const rd = new Date(result + "T00:00:00Z");
  assert.ok(rd > todayMs, "Should be in the future");
  const daysOut = Math.round((rd - todayMs) / 86400000);
  assert.ok(daysOut >= 4 && daysOut <= 6, "Should be ~5 days out, got: " + daysOut);
});

test("advancePayday: future date stays unchanged", () => {
  const future = futureDate(10);
  const result = v3.advancePayday(future, "monthly");
  assert.strictEqual(result, future, "Future date should not change");
});

test("income auto-advances payday when nextPayday not provided", () => {
  let s = setupState();
  s.payFrequency = "monthly";
  s.payday = pastDate(2); // Must be in the past so advancePayday actually advances it
  const oldPayday = s.payday;
  s = v3.applyAction(s, { type: "income", data: { amountUSD: 5000, description: "Salary" } });
  assert.notStrictEqual(s.payday, oldPayday, "Payday should auto-advance");
  assert.ok(s.payday > v3.today(), "New payday should be in future");
});

test("income respects explicit nextPayday over auto-advance", () => {
  let s = setupState();
  s.payFrequency = "biweekly";
  const explicit = futureDate(20);
  s = v3.applyAction(s, { type: "income", data: { amountUSD: 5000, nextPayday: explicit } });
  assert.strictEqual(s.payday, explicit, "Explicit nextPayday should take precedence");
});

test("setup stores payFrequency", () => {
  let s = v3.createFreshState();
  s = v3.applyAction(s, { type: "setup", data: { balanceUSD: 1000, payday: futureDate(14), payFrequency: "biweekly" } });
  assert.strictEqual(s.payFrequency, "biweekly");
});

test("createFreshState includes payFrequency null", () => {
  const s = v3.createFreshState();
  assert.strictEqual(s.payFrequency, null);
});

// ════════════════════════════════════════════════════════════════════
console.log("\n--- Irregular Income & Payday Overdue ---");

test("advancePayday with irregular frequency returns same date (no advance)", () => {
  const past = pastDate(5);
  const result = v3.advancePayday(past, "irregular", "UTC");
  assert.strictEqual(result, past, "Irregular should NOT advance payday");
});

test("computePicture: expired payday with irregular freq gives 30-day rolling horizon", () => {
  let s = setupState();
  s.payday = pastDate(3);
  s.payFrequency = "irregular";
  const pic = computePicture(s);
  assert.ok(pic.daysLeft >= 28 && pic.daysLeft <= 31, "Should be ~30 days, got: " + pic.daysLeft);
  assert.strictEqual(pic.paydayOverdue, true, "paydayOverdue should be true");
});

test("computePicture: expired payday with monthly freq auto-advances for display", () => {
  let s = setupState();
  s.payday = pastDate(5);
  s.payFrequency = "monthly";
  const pic = computePicture(s);
  assert.ok(pic.daysLeft > 1, "Should auto-advance, got daysLeft: " + pic.daysLeft);
  assert.strictEqual(pic.paydayOverdue, true, "paydayOverdue should be true");
  // displayPayday should be in the future
  assert.ok(pic.displayPayday > v3.today("UTC"), "displayPayday should be future: " + pic.displayPayday);
});

test("computePicture: future payday is NOT overdue", () => {
  let s = setupState();
  s.payday = futureDate(15);
  const pic = computePicture(s);
  assert.strictEqual(pic.paydayOverdue, false, "Future payday should not be overdue");
  assert.strictEqual(pic.daysLeft, 15, "daysLeft should be 15");
});

test("computePicture: irregular income dailyPace is reasonable (not all money in one day)", () => {
  let s = setupState();
  s.payday = pastDate(2);
  s.payFrequency = "irregular";
  s.balanceCents = 300000; // $3000
  const pic = computePicture(s);
  // dailyPace should be ~$100/day (3000/30), not $3000/1
  assert.ok(pic.dailyPaceCents < 200000, "dailyPace should be spread over ~30 days, got: " + pic.dailyPaceCents);
  assert.ok(pic.dailyPaceCents > 0, "dailyPace should be positive");
});

test("income action with irregular frequency does NOT auto-advance payday", () => {
  let s = setupState();
  s.payFrequency = "irregular";
  s.payday = pastDate(5);
  const originalPayday = s.payday;
  s = v3.applyAction(s, { type: "income", data: { amountUSD: 2000 } });
  // With irregular, payday stays the same (advancePayday returns same date)
  assert.strictEqual(s.payday, originalPayday, "Irregular income should not auto-advance payday");
});

test("setup with payFrequency irregular sets payday 30 days out", () => {
  let s = v3.createFreshState();
  s = v3.applyAction(s, {
    type: "setup",
    data: { balanceUSD: 500, payFrequency: "irregular" },
  });
  assert.strictEqual(s.payFrequency, "irregular");
  // Payday defaults to ~30 days out
  const dl = v3.daysUntil(s.payday, "UTC");
  assert.ok(dl >= 29 && dl <= 31, "Default payday should be ~30 days out, got: " + dl);
});

test("system prompt includes irregular in payFrequency options", () => {
  const s = setupState();
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("irregular"), "Prompt should mention irregular payFrequency");
});

test("system prompt includes paydayOverdue in state snapshot", () => {
  const s = setupState();
  s.payday = pastDate(3);
  s.payFrequency = "irregular";
  const prompt = buildSystemPrompt(s);
  assert.ok(prompt.includes("paydayOverdue"), "Prompt should include paydayOverdue field");
});

// ════════════════════════════════════════════════════════════════════
// SUMMARY
console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log("  - " + f.name + ": " + f.err.message);
  }
}
console.log("=".repeat(50) + "\n");

process.exit(failed > 0 ? 1 : 0);
