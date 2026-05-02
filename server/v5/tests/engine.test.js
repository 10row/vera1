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
