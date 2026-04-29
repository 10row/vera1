"use strict";
// DNA graph: pure compute over state. Categorization, patterns, summary.

const m = require("../model");
const { applyIntent } = require("../engine");
const dna = require("../dna");

function setup(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
}

test("[dna] empty state → empty graph", () => {
  const g = dna.compute(m.createFreshState());
  assertEq(g.nodes.length, 0);
  assertEq(g.summary.setup, false);
});

test("[dna] categorize: 'Starbucks latte' → coffee", () => {
  assertEq(dna.categorize("Starbucks latte"), "coffee");
});
test("[dna] categorize: 'Trader Joe groceries' → groceries", () => {
  assertEq(dna.categorize("Trader Joe groceries"), "groceries");
});
test("[dna] categorize: 'Uber to airport' → transport", () => {
  assertEq(dna.categorize("Uber to airport"), "transport");
});
test("[dna] categorize: 'random thing' → other", () => {
  assertEq(dna.categorize("random thing"), "other");
});
test("[dna] categorize: empty → other", () => {
  assertEq(dna.categorize(""), "other");
});

test("[dna] graph: 5 coffees → coffee category with 5 txs", () => {
  let s = setup();
  for (let i = 0; i < 5; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: 500, note: "coffee" } }).state;
  }
  const g = dna.compute(s);
  const coffee = g.nodes.find(n => n.id === "cat:coffee");
  assertTrue(!!coffee, "coffee category exists");
  assertEq(coffee.transactions, 5);
});

test("[dna] graph: bill node appears for added bill", () => {
  let s = setup();
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: m.addDays(m.today("UTC"), 14), recurrence: "monthly" },
  }).state;
  const g = dna.compute(s);
  const rent = g.nodes.find(n => n.id === "bill:rent");
  assertTrue(!!rent);
  assertEq(rent.recurrence, "monthly");
});

test("[dna] renderForPrompt: empty state → empty string", () => {
  assertEq(dna.renderForPrompt(dna.compute(m.createFreshState())), "");
});

test("[dna] renderForPrompt: produces compact summary", () => {
  let s = setup();
  for (let i = 0; i < 5; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: 500, note: "coffee" } }).state;
  }
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 4000, note: "groceries trader joe" } }).state;
  const text = dna.renderForPrompt(dna.compute(s));
  assertTrue(text.includes("DNA SUMMARY"));
  assertTrue(text.includes("CATEGORIES"));
  assertTrue(/coffee/i.test(text));
  // Should be under 1KB even with 5 categories.
  assertTrue(text.length < 1500, "DNA prompt too large: " + text.length + " chars");
});

test("[dna] graph scales: 200 random spends → still produces graph", () => {
  let s = setup(50_000_00);
  const notes = ["coffee", "groceries", "uber", "lunch", "netflix", "starbucks"];
  for (let i = 0; i < 200; i++) {
    s = applyIntent(s, {
      kind: "record_spend",
      params: { amountCents: 500 + (i * 7) % 2000, note: notes[i % notes.length] },
    }).state;
  }
  const g = dna.compute(s);
  assertTrue(g.nodes.length > 0, "has nodes");
  assertEq(g.summary.txCount, 200);
});
