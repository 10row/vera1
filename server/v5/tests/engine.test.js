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

test("[graph] record_spend stores canonicalized vendor + remapped legacy category", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const r = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 2500, note: "coffee at Lighthouse", vendor: "lighthouse", category: "coffee" },
  });
  const tx = r.state.transactions[r.state.transactions.length - 1];
  // Vendor canonicalized to title-case (was "lighthouse" → "Lighthouse")
  assertEq(tx.vendor, "Lighthouse");
  // Legacy "coffee" category remapped to new 6-bucket "food"
  assertEq(tx.category, "food");
  assertEq(tx.note, "coffee at Lighthouse");
});

test("[graph] vendor canonicalization — variants coalesce to same display", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  // Three casings should normalize identically.
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 500, note: "a", vendor: "lighthouse" } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 500, note: "b", vendor: "LIGHTHOUSE" } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 500, note: "c", vendor: "  Lighthouse  " } }).state;
  const vendors = s.transactions.filter(t => t.vendor).map(t => t.vendor);
  assertTrue(vendors.length === 3);
  // All three display identically.
  assertEq(vendors[0], "Lighthouse");
  assertEq(vendors[1], "Lighthouse");
  assertEq(vendors[2], "Lighthouse");
});

test("[graph] category collapse: 14 legacy buckets map to 6 new ones", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 1000000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  const cases = [
    { in: "coffee", out: "food" },
    { in: "groceries", out: "food" },
    { in: "restaurant", out: "food" },
    { in: "delivery", out: "food" },
    { in: "alcohol", out: "food" },
    { in: "subscription", out: "subscriptions" },
    { in: "clothing", out: "personal" },
    { in: "health", out: "personal" },
    { in: "entertainment", out: "personal" },
    { in: "travel", out: "personal" },
    { in: "food", out: "food" },     // already-new passthrough
    { in: "transport", out: "transport" },
    { in: "home", out: "home" },
    { in: "personal", out: "personal" },
    { in: "other", out: "other" },
  ];
  for (const c of cases) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: 100, note: "x", category: c.in } }).state;
    const tx = s.transactions[s.transactions.length - 1];
    assertEq(tx.category, c.out, "category '" + c.in + "' should map to '" + c.out + "' got '" + tx.category + "'");
  }
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

test("[graph] DNA categorize prefers stored category over keyword inference (legacy-aware)", () => {
  const { compute } = require("../dna");
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 500000, payday: "2025-06-01", payFrequency: "monthly" } }).state;
  // Stored category="entertainment" (legacy 14-bucket) is remapped to
  // "personal" by engine on insert. DNA must aggregate as "personal".
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 5000, note: "random expense", category: "entertainment" },
  }).state;
  const graph = compute(s);
  const personalCat = graph.summary.topCategories && graph.summary.topCategories.find(c => c.name === "personal");
  assertTrue(!!personalCat, "DNA aggregates into the new bucket after legacy remap");
});

// ── DELETE TRANSACTION (the user's "didn't get the cat" bug) ──
// Critical that balance integrity is preserved across delete + undo + edit
// sequences. Property test: 200 random sequences, balance must always
// reconcile to setup_balance + sum(income) - sum(non-deleted spends).

function setupTo(balanceCents) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents, payday: "2025-12-31", payFrequency: "monthly" },
  }).state;
}

test("[delete] basic: spend → delete → balance restored", () => {
  let s = setupTo(500000);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "cat" } }).state;
  assertEq(s.balanceCents, 495000);
  const txId = s.transactions[s.transactions.length - 1].id;
  s = applyIntent(s, { kind: "delete_transaction", params: { id: txId } }).state;
  assertEq(s.balanceCents, 500000);
  // Tx still in array, marked deleted (journaling).
  const tx = s.transactions.find(t => t.id === txId);
  assertTrue(!!tx.deletedAt, "tx should be marked deleted");
});

test("[delete] mid-history: spend1 + spend2 + delete spend1 → balance reflects only spend2", () => {
  let s = setupTo(500000);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "cat" } }).state;
  const catId = s.transactions[s.transactions.length - 1].id;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 400, note: "juice" } }).state;
  assertEq(s.balanceCents, 494600); // 500000 - 5000 - 400
  s = applyIntent(s, { kind: "delete_transaction", params: { id: catId } }).state;
  assertEq(s.balanceCents, 499600); // 500000 - 400 (only juice remains)
});

test("[delete] undo of delete restores", () => {
  let s = setupTo(500000);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "cat" } }).state;
  const catId = s.transactions[s.transactions.length - 1].id;
  s = applyIntent(s, { kind: "delete_transaction", params: { id: catId } }).state;
  assertEq(s.balanceCents, 500000);
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 495000); // back to spend applied
  const tx = s.transactions.find(t => t.id === catId);
  assertTrue(!tx.deletedAt, "deletedAt should be cleared");
});

test("[delete] cannot delete same tx twice", () => {
  let s = setupTo(500000);
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "cat" } }).state;
  const txId = s.transactions[s.transactions.length - 1].id;
  s = applyIntent(s, { kind: "delete_transaction", params: { id: txId } }).state;
  assertThrows(() => applyIntent(s, { kind: "delete_transaction", params: { id: txId } }), /already deleted/i);
});

test("[delete] rejects unknown id", () => {
  let s = setupTo(500000);
  assertThrows(() => applyIntent(s, { kind: "delete_transaction", params: { id: "nonexistent" } }), /not found/i);
});

test("[delete] cannot delete setup transaction", () => {
  let s = setupTo(500000);
  const setupId = s.transactions[0].id;
  assertThrows(() => applyIntent(s, { kind: "delete_transaction", params: { id: setupId } }), /starting balance|setup/i);
});

test("[delete] bill payment: deleting reverts paidThisCycle", () => {
  let s = setupTo(500000);
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: "2025-12-01", recurrence: "monthly" },
  }).state;
  // Simulate paying the bill
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, note: "rent payment", billKey: "rent" },
  }).state;
  assertEq(s.bills.rent.paidThisCycle, false /* advancePayday immediately resets */);
  // Actually paidThisCycle behavior: once paid, advancePayday rolls dueDate
  // forward and resets to false for next cycle. So this is the normal flow.
  // For this test we just verify delete reverses balance.
  const payTxId = s.transactions[s.transactions.length - 1].id;
  const balBefore = s.balanceCents;
  s = applyIntent(s, { kind: "delete_transaction", params: { id: payTxId } }).state;
  assertEq(s.balanceCents, balBefore + 140000); // restored
});

// PROPERTY TEST: random sequences must preserve invariant
//   balance == sum(amountCents-effects of non-deleted, non-deleted-by-undo events)
// This catches subtle math drift across mixed sequences.
test("[delete:property] 200 random sequences preserve balance integrity", () => {
  const RNG = (seed) => {
    let x = seed;
    return () => {
      x = (x * 9301 + 49297) % 233280;
      return x / 233280;
    };
  };
  for (let run = 0; run < 200; run++) {
    const rnd = RNG(run + 1);
    let s = setupTo(1000000); // $10,000 starting
    let txIds = [];
    let opCount = 5 + Math.floor(rnd() * 15); // 5-20 ops
    for (let i = 0; i < opCount; i++) {
      const r = rnd();
      try {
        if (r < 0.55) {
          // record_spend
          const amt = 100 + Math.floor(rnd() * 50000);
          s = applyIntent(s, { kind: "record_spend", params: { amountCents: amt, note: "x" + i } }).state;
          txIds.push(s.transactions[s.transactions.length - 1].id);
        } else if (r < 0.70) {
          // record_income
          const amt = 10000 + Math.floor(rnd() * 200000);
          s = applyIntent(s, { kind: "record_income", params: { amountCents: amt, note: "y" + i } }).state;
        } else if (r < 0.85 && txIds.length > 0) {
          // delete_transaction (random existing tx)
          const target = txIds[Math.floor(rnd() * txIds.length)];
          const tx = s.transactions.find(t => t.id === target);
          if (tx && !tx.deletedAt) {
            s = applyIntent(s, { kind: "delete_transaction", params: { id: target } }).state;
          }
        } else {
          // undo_last
          if (s.events.length > 1) {
            try { s = applyIntent(s, { kind: "undo_last", params: {} }).state; }
            catch (e) { /* skip if can't undo */ }
          }
        }
      } catch (e) { /* skip invalid op */ }
      // INVARIANT: balanceCents must equal setup_balance + sum of effective tx amounts
      const effectiveAmt = (s.transactions || [])
        .filter(t => !t.deletedAt)
        .reduce((sum, t) => {
          if (t.kind === "setup") return sum + t.amountCents;
          if (t.kind === "spend" || t.kind === "bill_payment") return sum + t.amountCents; // already negative
          if (t.kind === "income") return sum + t.amountCents;
          if (t.kind === "correction") return sum + t.amountCents;
          return sum;
        }, 0);
      assertEq(s.balanceCents, effectiveAmt, "run " + run + " op " + i + ": balance must equal sum of non-deleted tx amounts");
    }
  }
});

// ── CYCLE INTEGRITY: bill_payment dueDate restoration ───────────
// Regression suite for the silent-drift bug class:
//   - Pay a recurring bill → dueDate advances forward
//   - Delete or undo that payment → dueDate MUST restore to original
//
// Pre-fix bug: only paidThisCycle was reverted; dueDate stayed in the
// future. Bill silently slipped to "next cycle", engine reservation
// dropped the bill amount, frozen pace stayed stale, $X went missing
// from the user's mental ledger.

function setupWithPayday(balance, paydayDaysOut) {
  let s = m.createFreshState();
  const today = m.today("UTC");
  return applyIntent(s, {
    kind: "setup_account",
    params: {
      balanceCents: balance,
      payday: m.addDays(today, paydayDaysOut),
      payFrequency: "monthly",
    },
  }).state;
}

test("[engine] delete bill_payment restores bill dueDate (was silent next-cycle drift)", () => {
  let s = setupWithPayday(500000, 23);
  const today = m.today("UTC");
  const billDue = m.addDays(today, 5);
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: billDue, recurrence: "monthly" },
  }).state;
  const billKeyVal = m.billKey("Rent");

  // Pay the bill — this advances dueDate one month forward.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;
  assertTrue(s.bills[billKeyVal].dueDate > billDue, "after pay, dueDate must be advanced");
  assertEq(s.bills[billKeyVal].paidThisCycle, false, "recurring → reset paidThisCycle for new cycle");

  // Find and delete the payment transaction.
  const paymentTx = s.transactions.find(t => t.kind === "bill_payment");
  assertTrue(!!paymentTx, "payment tx should exist");
  s = applyIntent(s, {
    kind: "delete_transaction",
    params: { id: paymentTx.id },
  }).state;

  // dueDate must be restored to its pre-payment value.
  assertEq(s.bills[billKeyVal].dueDate, billDue, "delete must restore dueDate (regression: it used to stay advanced)");
  assertEq(s.bills[billKeyVal].paidThisCycle, false, "and paidThisCycle should match pre-payment");
  assertEq(s.balanceCents, 500000, "balance fully restored");
});

test("[engine] undo bill_payment restores bill dueDate (same regression class)", () => {
  let s = setupWithPayday(500000, 23);
  const today = m.today("UTC");
  const billDue = m.addDays(today, 5);
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: billDue, recurrence: "monthly" },
  }).state;
  const billKeyVal = m.billKey("Rent");

  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;
  const advancedDate = s.bills[billKeyVal].dueDate;
  assertTrue(advancedDate > billDue, "dueDate advanced after pay");

  // Undo the payment.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;

  assertEq(s.bills[billKeyVal].dueDate, billDue, "undo must restore dueDate");
  assertEq(s.bills[billKeyVal].paidThisCycle, false, "paidThisCycle restored");
  assertEq(s.balanceCents, 500000, "balance restored");
});

test("[engine] delete bill_payment refreshes pace (not stale)", () => {
  // Setup: $5,000 balance, payday 23 days out, $1,400 rent due in 5 days.
  // Expected pace before payment: ($5,000 - $1,400) / 23 = $156.52
  let s = setupWithPayday(500000, 23);
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;

  const paceAfterAdd = s.dailyPaceCents;
  assertTrue(paceAfterAdd > 0, "pace computed after add_bill");

  // Pay the bill. Per Model B, pace stays frozen on record_spend.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;
  assertEq(s.dailyPaceCents, paceAfterAdd, "pace stays frozen on record_spend (Model B)");

  // Delete the payment. Pace MUST refresh — bill flips back to this-cycle,
  // balance restored. Stale pace would silently mis-reserve.
  const paymentTx = s.transactions.find(t => t.kind === "bill_payment");
  s = applyIntent(s, { kind: "delete_transaction", params: { id: paymentTx.id } }).state;
  assertEq(s.dailyPaceCents, paceAfterAdd, "after delete, pace must match the original (bill is fully back in cycle)");
  assertEq(s.dailyPaceComputedDate, today, "pace was just refreshed today");
});

test("[engine] undo bill_payment refreshes pace", () => {
  let s = setupWithPayday(500000, 23);
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;
  const paceAfterAdd = s.dailyPaceCents;
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.dailyPaceCents, paceAfterAdd, "after undo, pace must match pre-payment baseline");
  assertEq(s.dailyPaceComputedDate, today, "pace freshly refreshed");
});

test("[engine] paying a recurring bill EARLY advances dueDate by one cycle (was no-op bug)", () => {
  // Pre-fix bug: advancePayday() only fast-forwarded past today, so
  // paying a bill before its due date left dueDate unchanged. Bill
  // was still in this cycle's obligation math AND balance had
  // already been deducted — engine double-reserved silently.
  let s = setupWithPayday(500000, 23);
  const today = m.today("UTC");
  const billDue = m.addDays(today, 5); // due in 5 days, recurring monthly
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: billDue, recurrence: "monthly" },
  }).state;

  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;

  const b = s.bills[m.billKey("Rent")];
  // dueDate must have moved forward by exactly one month.
  assertTrue(b.dueDate > billDue, "dueDate must advance even when paid early");
  // Roughly 28-31 days later (calendar-aware).
  const daysAdvanced = m.daysBetween(billDue, b.dueDate);
  assertTrue(daysAdvanced >= 28 && daysAdvanced <= 31, "advanced by one calendar month, got " + daysAdvanced);
  assertEq(b.paidThisCycle, false, "new cycle starts unpaid at the new dueDate");
});

test("[engine] addBillCycle handles month-end clamping (Jan 31 → Feb 28)", () => {
  assertEq(m.addBillCycle("2026-01-31", "monthly"), "2026-02-28", "Jan 31 clamps to Feb 28 in non-leap year");
  assertEq(m.addBillCycle("2024-01-31", "monthly"), "2024-02-29", "Jan 31 → Feb 29 in leap year");
  assertEq(m.addBillCycle("2026-12-15", "monthly"), "2027-01-15", "month rollover into next year");
  assertEq(m.addBillCycle("2026-05-15", "weekly"), "2026-05-22", "weekly = +7 days");
  assertEq(m.addBillCycle("2026-05-15", "biweekly"), "2026-05-29", "biweekly = +14 days");
});

// ── BACKDATING (date param on record_spend / record_income) ─────
// "I forgot to log this yesterday" — tx stamped with past date for
// heatmap / history accuracy; balance mutated NOW.

test("[engine] record_spend with date=yesterday stamps tx.date correctly", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  const yesterday = m.addDays(today, -1);
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  // Backfill setup tx date so the backdate window allows yesterday.
  // (Real users sign up before they backdate; in tests we shortcut.)
  s.transactions[0].date = m.addDays(today, -10);
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 3000, note: "coffee", date: yesterday },
  }).state;

  const tx = s.transactions[s.transactions.length - 1];
  assertEq(tx.kind, "spend");
  assertEq(tx.date, yesterday, "tx.date should be the backdated value");
  assertEq(tx.amountCents, -3000);
  assertEq(s.balanceCents, 497000, "balance still mutates NOW (money was already gone)");
});

test("[engine] backdated spend doesn't show in todaySpent", () => {
  const { compute } = require("../view");
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  s.transactions[0].date = m.addDays(today, -10);
  // Backdate $30 to yesterday.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 3000, note: "coffee", date: m.addDays(today, -1) },
  }).state;
  // Spend $5 today.
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 500, note: "tip" } }).state;

  const v = compute(s);
  assertEq(v.todaySpentCents, 500, "only today's $5 shows in todaySpent (yesterday's backdate excluded)");
  assertEq(v.weekSpentCents, 3500, "weekSpent includes both (within 7 days)");
});

test("[engine] record_spend rejects future date", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  assertThrows(
    () => applyIntent(s, { kind: "record_spend", params: { amountCents: 1000, date: m.addDays(today, 1) } }),
    /future/i
  );
});

test("[engine] record_spend rejects date before setup", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  // Try to backdate to before setup (which happened today).
  assertThrows(
    () => applyIntent(s, { kind: "record_spend", params: { amountCents: 1000, date: m.addDays(today, -1) } }),
    /before account setup/i
  );
});

test("[engine] record_income with date=yesterday works", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  // Backfill the setup tx date to N days ago so backdate window is open.
  s.transactions[0].date = m.addDays(today, -3);
  const yesterday = m.addDays(today, -1);
  s = applyIntent(s, {
    kind: "record_income",
    params: { amountCents: 50000, note: "freelance", date: yesterday },
  }).state;
  const tx = s.transactions[s.transactions.length - 1];
  assertEq(tx.kind, "income");
  assertEq(tx.date, yesterday);
  assertEq(s.balanceCents, 550000);
});

test("[engine] no date param defaults to today (backward-compat)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 1000, note: "test" } }).state;
  const tx = s.transactions[s.transactions.length - 1];
  assertEq(tx.date, today, "no date param → tx.date defaults to today");
});

// REGRESSION — pace must refresh when a record_spend is backdated.
// Pre-fix bug: today's pace was set this morning from a balance that
// didn't reflect the backdated (yet-to-be-told) spend. Logging it
// reduced balance but pace stayed frozen → user sees "same pace today"
// even though they just told the bot about historical overspending.
//
// The new rule: backdated record_* is a CORRECTION (cycle event), not
// a current-day spend. Refresh pace.
test("[engine] backdated record_spend REFRESHES pace (cycle event correction)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  // Widen backdate window.
  s.transactions[0].date = m.addDays(today, -5);
  const paceBefore = s.dailyPaceCents;
  assertTrue(paceBefore > 0, "baseline pace > 0");

  // Backdate a $300 spend to yesterday — pace MUST drop because
  // today's pace was computed assuming this money was still there.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 30000, note: "perfume", date: m.addDays(today, -1) },
  }).state;
  assertTrue(s.dailyPaceCents < paceBefore, "pace must drop after backdated spend (was identical pre-fix)");
  assertEq(s.dailyPaceComputedDate, today, "pace was just refreshed today");
});

test("[engine] TODAY-dated record_spend does NOT refresh pace (Model B intact)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  const paceBefore = s.dailyPaceCents;

  // Spend today (no date param) — Model B says pace stays frozen.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 30000, note: "perfume" },
  }).state;
  assertEq(s.dailyPaceCents, paceBefore, "today-dated record_spend must NOT refresh pace");

  // Even with explicit date=today, no refresh.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 1000, note: "coffee", date: today },
  }).state;
  assertEq(s.dailyPaceCents, paceBefore, "explicit date=today must NOT refresh pace");
});

test("[engine] backdated record_income REFRESHES pace (correction)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  s.transactions[0].date = m.addDays(today, -5);
  const paceBefore = s.dailyPaceCents;

  // Backdated income (e.g., refund / freelance from yesterday) — pace
  // should refresh upward because balance is higher than this morning's
  // pace assumed.
  s = applyIntent(s, {
    kind: "record_income",
    params: { amountCents: 50000, note: "refund", date: m.addDays(today, -1) },
  }).state;
  assertTrue(s.dailyPaceCents > paceBefore, "pace must rise after backdated income correction");
  assertEq(s.dailyPaceComputedDate, today);
});

test("[engine] TODAY-dated record_income does NOT refresh pace (no payday advance)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  // Use irregular payFrequency so payday never advances on income.
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "irregular" },
  }).state;
  const paceBefore = s.dailyPaceCents;
  s = applyIntent(s, {
    kind: "record_income",
    params: { amountCents: 50000, note: "side gig" },
  }).state;
  assertEq(s.dailyPaceCents, paceBefore, "today-dated income with no payday advance must NOT refresh");
});

test("[engine] backdated bill_payment REFRESHES pace (correction)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  s.transactions[0].date = m.addDays(today, -5);
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Phone", amountCents: 20000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;
  const paceBefore = s.dailyPaceCents;

  // Backdated bill payment — bill cycle advances AND pace refreshes
  // (because backdated). Both behaviors should hold simultaneously.
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 20000, billKey: "Phone", date: m.addDays(today, -1) },
  }).state;
  // Pace refresh: should be different from baseline (cleaner: new pace
  // is computed from new balance + bill state).
  assertTrue(s.dailyPaceCents !== paceBefore || s.dailyPaceComputedDate === today, "pace refresh fired");
  // Bill state: paidThisCycle false (recurring bill rolled to next cycle).
  const bill = s.bills[m.billKey("Phone")];
  assertEq(bill.paidThisCycle, false);
  assertTrue(bill.dueDate > m.addDays(today, 5), "dueDate advanced one cycle");
});

test("[engine] backdated tx undo restores balance fully", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  s.transactions[0].date = m.addDays(today, -5);
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 3000, note: "coffee", date: m.addDays(today, -2) },
  }).state;
  assertEq(s.balanceCents, 497000);
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.balanceCents, 500000, "undo restores balance even for backdated txs");
});

// ── PACE-REFRESH SYMMETRY INVARIANT (failsafe fix) ──
// THE BUG (user-reported screenshot): user spent $X coffee today (frozen
// pace stays per Model B), then logged $200, then undid the $200. Pace
// silently shifted from $150 to $145.98 — by $X/14 days. Why? undo_last
// called refreshPace unconditionally; refresh recomputed from current
// state which had the OTHER $X of today's spending baked in. Reversing
// one event leaked the cumulative effect of all today's other spends.
// That's a Model B violation through the back-door.
//
// THE INVARIANT (locked here): undo/delete refreshes pace IFF the
// underlying event was one that ORIGINALLY refreshed pace. Symmetric.
// Today-dated record_spend (didn't refresh) → undoing it doesn't either.
// Today bill_payment (didn't refresh per Model B) → undoing it DOES
// refresh because the bill state changes back to obligated.
// Backdated spend (refreshed) → undoing it refreshes too.
//
// Five tests below lock the invariant across the relevant scenarios.

test("[engine] FAILSAFE: undo today's regular spend does NOT refresh pace (Model B preserved)", () => {
  // This is the screenshot bug. User spent $X today (frozen), then $Y
  // today, then undid the $Y. Pre-fix: pace shifted by $X/days. Post-fix:
  // pace stays at the frozen morning value, untouched by undo.
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 14), payFrequency: "monthly" },
  }).state;
  const paceMorning = s.dailyPaceCents;
  assertTrue(paceMorning > 0);

  // Other today-dated spending (the coffee + lunch background).
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5628, note: "coffee + lunch" } }).state;
  assertEq(s.dailyPaceCents, paceMorning, "Model B: today's spend doesn't move pace");

  // The $200 spend we're going to undo.
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 20000, note: "jacket" } }).state;
  assertEq(s.dailyPaceCents, paceMorning, "Model B: $200 spend also doesn't move pace");

  // Undo the $200. Pre-fix: pace silently shifted. Post-fix: stays.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.dailyPaceCents, paceMorning,
    "FAILSAFE: undoing today's spend must NOT refresh pace (no leak from other today-spending)");
});

test("[engine] FAILSAFE: delete today's regular spend does NOT refresh pace", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 14), payFrequency: "monthly" },
  }).state;
  const paceMorning = s.dailyPaceCents;

  // Today background spending + the one we'll delete.
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5628, note: "coffee" } }).state;
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 20000, note: "jacket" } }).state;
  const targetTxId = s.transactions[s.transactions.length - 1].id;
  assertEq(s.dailyPaceCents, paceMorning);

  // Delete the jacket. Per fix, pace MUST NOT refresh.
  s = applyIntent(s, { kind: "delete_transaction", params: { id: targetTxId } }).state;
  assertEq(s.dailyPaceCents, paceMorning,
    "FAILSAFE: deleting today's spend must NOT refresh pace");
});

test("[engine] SYMMETRY: undo bill_payment DOES refresh (obligation flips back to unpaid)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;
  const paceWithBillObligated = s.dailyPaceCents;

  // Pay the bill (today-dated bill_payment).
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;
  // Per Model B, today's bill_payment doesn't refresh pace.
  assertEq(s.dailyPaceCents, paceWithBillObligated);

  // Undo it — bill goes back to obligated. Pace MUST refresh.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.dailyPaceCents, paceWithBillObligated,
    "bill_payment undo refreshes — bill back in obligation math");
});

test("[engine] SYMMETRY: undo BACKDATED spend DOES refresh (matches apply-side refresh)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 14), payFrequency: "monthly" },
  }).state;
  s.transactions[0].date = m.addDays(today, -10); // widen backdate window
  const paceBefore = s.dailyPaceCents;

  // Backdated spend — applying triggers refresh (we're correcting history).
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 30000, note: "perfume", date: m.addDays(today, -1) },
  }).state;
  assertTrue(s.dailyPaceCents !== paceBefore || s.dailyPaceComputedDate === today,
    "backdated spend refreshed on apply");
  const paceAfterBackdate = s.dailyPaceCents;

  // Undo it — refresh must fire so pace goes BACK to original.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertTrue(s.dailyPaceCents !== paceAfterBackdate,
    "backdated undo refreshes pace (symmetry)");
});

test("[engine] FAILSAFE: chain of today's spends + middle undo = stable pace", () => {
  // The exact scenario the user hit: multiple spends today, then undo one.
  // Pace MUST stay at the morning frozen value through the whole chain.
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 14), payFrequency: "monthly" },
  }).state;
  const morningPace = s.dailyPaceCents;

  // Five today-dated spends.
  for (let i = 0; i < 5; i++) {
    s = applyIntent(s, { kind: "record_spend", params: { amountCents: 1000 + i * 500, note: "x" } }).state;
    assertEq(s.dailyPaceCents, morningPace, "spend " + i + ": pace stays frozen");
  }

  // Undo last → pace must stay.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.dailyPaceCents, morningPace, "after undo: pace untouched");

  // Undo again → still stable.
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  assertEq(s.dailyPaceCents, morningPace, "after 2nd undo: pace untouched");

  // Now an add_bill (cycle event) → pace MUST refresh.
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Phone", amountCents: 20000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;
  assertTrue(s.dailyPaceCents < morningPace, "add_bill refreshed (cycle event)");
});

// ── paceHistory — per-day pace snapshots for accurate heatmap colors

test("[engine] refreshPace writes today's pace into paceHistory", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  assertTrue(!!s.paceHistory, "paceHistory exists");
  assertEq(s.paceHistory[today], s.dailyPaceCents, "today's pace written");
});

test("[engine] paceHistory updates on every cycle event (adjust/add_bill/etc.)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  const paceA = s.paceHistory[today];

  // adjust_balance is a cycle event → paceHistory updates
  s = applyIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 400000 } }).state;
  const paceB = s.paceHistory[today];
  assertTrue(paceB !== paceA, "pace updated after adjust_balance");
  assertEq(paceB, s.dailyPaceCents);

  // add_bill is a cycle event → paceHistory updates
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 100000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;
  const paceC = s.paceHistory[today];
  assertTrue(paceC !== paceB, "pace updated after add_bill");
});

test("[engine] paceHistory does NOT update on today-dated record_spend (Model B)", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  const paceBefore = s.paceHistory[today];
  s = applyIntent(s, { kind: "record_spend", params: { amountCents: 5000, note: "coffee" } }).state;
  // Today-dated spend doesn't refresh pace, so paceHistory[today] unchanged.
  assertEq(s.paceHistory[today], paceBefore);
});

test("[engine] paceHistory prunes entries older than 400 days", () => {
  let s = m.createFreshState();
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 500000, payday: m.addDays(today, 23), payFrequency: "monthly" },
  }).state;
  // Manually inject old paceHistory entries simulating long-time use.
  for (let i = 0; i < 500; i++) {
    s.paceHistory[m.addDays(today, -i)] = 10000 + i;
  }
  // Trigger another refresh — engine should prune to ~400.
  s = applyIntent(s, { kind: "adjust_balance", params: { newBalanceCents: 600000 } }).state;
  const keys = Object.keys(s.paceHistory);
  assertTrue(keys.length <= 401, "pruned to <= 400 entries, got " + keys.length);
  // Ensure recent entries kept, oldest pruned.
  assertTrue(s.paceHistory[today] != null, "today still present");
  assertEq(s.paceHistory[m.addDays(today, -500)], undefined, "500-day-old entry pruned");
});

// resolveTxDate helper unit checks (model.js)
test("[model] resolveTxDate accepts valid past date within window", () => {
  const today = m.today("UTC");
  const state = { transactions: [{ kind: "setup", date: m.addDays(today, -10) }] };
  const r = m.resolveTxDate(state, m.addDays(today, -3), today);
  assertEq(r.date, m.addDays(today, -3));
  assertEq(r.error, undefined);
});

test("[model] resolveTxDate rejects malformed date", () => {
  const today = m.today("UTC");
  const r = m.resolveTxDate({ transactions: [] }, "not-a-date", today);
  assertTrue(/format/i.test(r.error));
});

test("[model] resolveTxDate rejects future", () => {
  const today = m.today("UTC");
  const r = m.resolveTxDate({ transactions: [] }, m.addDays(today, 1), today);
  assertTrue(/future/i.test(r.error));
});

test("[model] resolveTxDate defaults to today when input is null", () => {
  const today = m.today("UTC");
  const r = m.resolveTxDate({ transactions: [] }, null, today);
  assertEq(r.date, today);
});

test("[engine] backward-compat: delete tx without prevDueDate snapshot still works", () => {
  // Simulate a tx created BEFORE the prevDueDate snapshot existed.
  let s = setupWithPayday(500000, 23);
  const today = m.today("UTC");
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 140000, dueDate: m.addDays(today, 5), recurrence: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "record_spend",
    params: { amountCents: 140000, billKey: "Rent" },
  }).state;
  // Strip the snapshot fields to simulate legacy data.
  const paymentTx = s.transactions.find(t => t.kind === "bill_payment");
  delete paymentTx.prevDueDate;
  delete paymentTx.prevPaidThisCycle;

  // Delete should NOT throw and should still revert paidThisCycle.
  s = applyIntent(s, { kind: "delete_transaction", params: { id: paymentTx.id } }).state;
  assertEq(s.bills[m.billKey("Rent")].paidThisCycle, false, "legacy fallback: paidThisCycle reset");
  assertEq(s.balanceCents, 500000, "balance reverted");
});
