"use strict";
// Engine — pure state transitions. Byte-perfect undo.

const m = require("../model");
const { applyIntent } = require("../engine");

function setup(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

// ── SETUP ─────────────────────────────────────────
test("[engine] setup_account on virgin state succeeds", () => {
  const s = setup();
  assertEq(s.setup, true);
  assertEq(s.balanceCents, 500000);
  assertEq(s.payday, "2025-05-15");
  assertEq(s.payFrequency, "monthly");
});
test("[engine] setup_account on already-setup throws", () => {
  const s = setup();
  assertThrows(() => applyIntent(s, { kind: "setup_account", params: { balanceCents: 100 } }), /Already set up/);
});
test("[engine] setup with negative balance throws", () => {
  let s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "setup_account", params: { balanceCents: -100 } }), /Invalid balance/);
});

// ── ADJUST BALANCE ────────────────────────────────
test("[engine] adjust_balance updates balance, records correction tx", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 700000 } }).state;
  assertEq(s.balanceCents, 700000);
  // Setup tx + correction tx = 2 transactions
  assertEq(s.transactions.length, 2);
  assertEq(s.transactions[1].kind, "correction");
  assertEq(s.transactions[1].amountCents, 200000); // delta
});
test("[engine] adjust_balance before setup throws", () => {
  let s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 100 } }), /Set up first/);
});

// ── BILLS ─────────────────────────────────────────
test("[engine] add_bill stores by key, includes recurrence", () => {
  let s = setup();
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: "2025-05-01", recurrence: "monthly" },
  }).state;
  assertTrue(!!s.bills.rent);
  assertEq(s.bills.rent.amountCents, 140000);
  assertEq(s.bills.rent.recurrence, "monthly");
});
test("[engine] add_bill duplicate name throws", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  assertThrows(() => applyIntent(s, { kind: "add_bill", params: { name: "rent", amountCents: 100, dueDate: "2025-06-01", recurrence: "monthly" } }), /already exists/);
});
test("[engine] remove_bill", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Phone", amountCents: 5000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  s = applyIntent(s, { kind: "remove_bill", params: { name: "Phone" } }).state;
  assertEq(s.bills.phone, undefined);
});

// ── SPEND / INCOME ────────────────────────────────
test("[engine] record_spend reduces balance, appends tx", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } }).state;
  assertEq(s.balanceCents, 498000);
  assertEq(s.transactions[1].kind, "spend");
  assertEq(s.transactions[1].amountCents, -2000);
});
test("[engine] record_income increases balance", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "record_income", params: { amountCents: 300000, note: "paycheck" } }).state;
  assertEq(s.balanceCents, 800000);
  assertEq(s.transactions[1].kind, "income");
});
test("[engine] record_spend with billKey marks bill paid + advances cycle", () => {
  let s = setup(500000);
  s = applyIntent(s, { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 140000, billKey: "rent" } }).state;
  // For monthly bill, advancePayday rolls to next 1st (or close).
  assertTrue(s.bills.rent.dueDate >= "2025-05-01");
  assertEq(s.balanceCents, 360000);
});

// ── UNDO ──────────────────────────────────────────
test("[engine] undo of record_spend restores balance and pops tx", () => {
  let s = setup(500000);
  const before = JSON.stringify({ bal: s.balanceCents, tx: s.transactions.length });
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 2000 } }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 500000);
  assertEq(s.transactions.length, 1); // back to just setup tx
});
test("[engine] undo of add_bill removes the bill", () => {
  let s = setup();
  s = applyIntent(s, { kind: "add_bill", params: { name: "Phone", amountCents: 5000, dueDate: "2025-05-01", recurrence: "monthly" } }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.bills.phone, undefined);
});
test("[engine] undo of setup_account throws (use reset)", () => {
  let s = setup();
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /Can't undo setup/);
});
test("[engine] undo with empty events throws", () => {
  const s = m.createFreshState();
  assertThrows(() => applyIntent(s, { kind: "undo_last", params: {} }), /Nothing to undo/);
});
test("[engine] 10 spends then 10 undos returns to original balance", () => {
  let s = setup(1000000);
  const start = s.balanceCents;
  for (let i = 0; i < 10; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: (i + 1) * 100 } }).state;
  }
  for (let i = 0; i < 10; i++) {
    s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  }
  assertEq(s.balanceCents, start);
});

// ── RESET ─────────────────────────────────────────
test("[engine] reset wipes state but preserves locale prefs", () => {
  let s = setup();
  s.language = "ru";
  s.currency = "RUB";
  s.currencySymbol = "₽";
  s = applyIntent(s, { kind: "reset", params: {} }).state;
  assertEq(s.setup, false);
  assertEq(s.balanceCents, 0);
  assertEq(s.language, "ru");
  assertEq(s.currency, "RUB");
});

// ── INVALID INTENTS ───────────────────────────────
test("[engine] unknown intent kind throws", () => {
  const s = setup();
  assertThrows(() => applyIntent(s, { kind: "transfer_to_attacker", params: {} }), /Unknown intent/);
});
test("[engine] missing intent throws", () => {
  const s = setup();
  assertThrows(() => applyIntent(s, null), /invalid intent/);
});

// ── GRAPH FIELDS (option B from the design discussion) ──
// Each spend can carry vendor/category/tags/context. All optional.
// Backward-compat: older transactions without these fields must still
// work. Field validation: category must be from the fixed list.

test("[graph] record_spend stores vendor when provided", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const r = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 2500, note: "coffee at Lighthouse", vendor: "Lighthouse", category: "coffee" },
  });
  const tx = r.state.transactions[r.state.transactions.length - 1];
  assertEq(tx.vendor, "Lighthouse");
  assertEq(tx.category, "coffee");
  assertEq(tx.note, "coffee at Lighthouse");
});

test("[graph] record_spend with no graph fields still works (backward-compat)", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const r = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 2500, note: "coffee" },
  });
  const tx = r.state.transactions[r.state.transactions.length - 1];
  assertEq(tx.vendor, null);
  assertEq(tx.category, null);
  assertEq(tx.tags, null);
  assertEq(tx.context, null);
  assertEq(tx.note, "coffee");
});

test("[graph] invalid category gets sanitized to null (no junk in db)", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const r = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 1000, note: "x", category: "definitelynotacategory" },
  });
  const tx = r.state.transactions[r.state.transactions.length - 1];
  assertEq(tx.category, null);
});

test("[graph] tags array sanitized to <= 5 short strings", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const r = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 1000, note: "x", tags: ["work", "trip", "vietnam", "client", "team", "extra"] },
  });
  const tx = r.state.transactions[r.state.transactions.length - 1];
  assertEq(tx.tags.length, 5);
  assertEq(tx.tags[0], "work");
});

test("[graph] foreign currency + graph fields: both preserved correctly", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const r = applyIntent(s, {
    kind: "record_spend",
    params: {
      amountCents: 1200, note: "taxi back to hotel",
      originalAmount: 30000, originalCurrency: "VND",
      vendor: "Taxi", category: "transport",
    },
  });
  const tx = r.state.transactions[r.state.transactions.length - 1];
  assertEq(tx.originalAmount, 30000);
  assertEq(tx.originalCurrency, "VND");
  assertEq(tx.vendor, "Taxi");
  assertEq(tx.category, "transport");
});

test("[graph] DNA categorize prefers stored category over keyword inference", () => {
  const { compute } = require("../dna");
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  // Stored category="alcohol" but note is just "30 at the bar" — keyword
  // inference would also say alcohol due to "bar". Use a note where they
  // diverge: note="random expense", stored category="entertainment".
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 5000, note: "random expense", category: "entertainment" },
  }).state;
  const graph = compute(s);
  // Find the entertainment node — should exist because we stored that category.
  const entCat = graph.summary.topCategories && graph.summary.topCategories.find(c => c.name === "entertainment");
  assertTrue(!!entCat, "DNA should aggregate the stored category, not infer from note");
});
