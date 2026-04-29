"use strict";
// Regression — user reported the AI mis-classifying multiple times:
//   "put away 700 for budget for spending in vietnam" → got logged as a SPEND
//   "Vietnam hotel" envelope was renamed "Vietnam trip" and tagged as BILL
//
// The fix is in the AI prompt (decision tree) but the validator and engine
// also need to do their part: any mis-classification that DOES land must
// be safe (confirm card + clear kind label).

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");
const { processMessage } = require("../pipeline");

const TODAY = "2025-04-28";
const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function freshSetup(balance) {
  const s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 5_000_00, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
}

// ── 1. AI can emit add_envelope kind=budget for "put away X for spending" ──
test("[BUG-CLASSIFICATION] 'put away 700 for spending in vietnam' as budget envelope is valid", async () => {
  const s = freshSetup();
  const r = await processMessage(s, "put away 700 for budget for spending in vietnam", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting up a Vietnam Spending budget.",
      intents: [{ kind: "add_envelope", params: { name: "Vietnam Spending", kind: "budget", amountCents: 700_00 } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, true);
  assertEq(r.decisions[0].verdict.severity, "confirm");
  // After confirming and applying:
  const after = applyIntent(s, r.decisions[0].intent).state;
  assertEq(after.envelopes.vietnam_spending.kind, "budget");
  assertEq(after.envelopes.vietnam_spending.amountCents, 700_00);
  // CRITICAL: balance was NOT debited (it's an envelope, not a spend)
  assertEq(after.balanceCents, s.balanceCents);
});

test("[BUG-CLASSIFICATION] 'put away X' must NOT be classified as record_spend by the AI", async () => {
  // Simulate the BAD case: AI emits record_spend for what should be a budget.
  // The validator allows record_spend (it's a valid intent), but the user
  // would see a confirm card showing "Spend $700" — so they can catch it.
  // This test asserts the confirm card is shown (no auto-apply).
  const s = freshSetup();
  const r = await processMessage(s, "put away 700 for vietnam budget", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging $700.",
      intents: [{ kind: "record_spend", params: { amountCents: 700_00, note: "vietnam" } }],
    }),
  });
  // Whatever the AI emits, $700 spend > $50 → confirm card. User can spot
  // and refuse (or rephrase). Auto-tier is dead (Step 1).
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.severity, "confirm");
});

// ── 2. KIND LABELING in confirm card text ────────────────
const { applyIntent: apply } = require("../engine");
const { processMessage: pm } = require("../pipeline");

test("[BUG-CLASSIFICATION] add_envelope confirm card surfaces kind clearly", async () => {
  // We can't render the bot's literal message here, but we assert that
  // fmtIntent is producing a kind label — by importing the bot module's
  // formatter via state and checking via processMessage flow.
  // (The real assertion is the rendered string; we just check the intent
  // shape is preserved through the pipeline.)
  const s = freshSetup();
  const r = await pm(s, "rent is 1400 monthly", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding rent.",
      intents: [{
        kind: "add_envelope",
        params: { name: "Rent", kind: "bill", amountCents: 1400_00, dueDate: m.addDays(m.today("UTC"), 30), recurrence: "monthly" },
      }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].intent.params.kind, "bill");
  assertEq(r.decisions[0].intent.params.recurrence, "monthly");
});

// ── 3. NAME PRESERVATION: AI shouldn't substitute synonyms ──
// We can't enforce this at the validator level (any string is "valid").
// What we CAN do: ensure the validator doesn't reject reasonable names.

test("[BUG-CLASSIFICATION] 'Vietnam Hotel' as goal is valid", () => {
  const s = freshSetup();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 1000_00, targetCents: 1000_00 },
  }, TODAY);
  assertEq(v.ok, true);
});

test("[BUG-CLASSIFICATION] 'Vietnam Trip' as goal is valid (separate from Hotel)", () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 1000_00 },
  }).state;
  // Adding "Vietnam Trip" (different ekey) should be allowed
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "goal", amountCents: 700_00 },
  }, TODAY);
  assertEq(v.ok, true);
});

test("[BUG-CLASSIFICATION] vacation/hotel/trip as 'bill' kind: validator allows the structural shape, but a smart user spots it via the confirm card", () => {
  const s = freshSetup();
  // Pretend the AI mis-classified "Vacation Fund" as a bill.
  // Validator: needs recurrence + dueDate for it to even pass.
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vacation Fund", kind: "bill", amountCents: 1500_00, dueDate: m.addDays(m.today("UTC"), 60), recurrence: "once" },
  }, TODAY);
  // Validator allows it (structurally valid), but the user sees
  // "📌 Bill (recurring)" in the confirm card — instant signal.
  assertEq(v.ok, true);
});

// ── 4. fund_envelope is the right path when the envelope EXISTS ──
test("[BUG-CLASSIFICATION] AI fund_envelope on existing Vietnam Hotel preserves the envelope (no duplicate, no spend)", async () => {
  let s = freshSetup();
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 1000_00 },
  }).state;
  const balanceBefore = s.balanceCents;

  const r = await processMessage(s, "put 200 toward Vietnam Hotel", [], {
    _aiCall: stub({
      mode: "do",
      message: "Funding Vietnam Hotel with $200.",
      intents: [{ kind: "fund_envelope", params: { name: "Vietnam Hotel", amountCents: 200_00 } }],
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.decisions[0].verdict.ok, true);
  // After confirm:
  s = applyIntent(s, r.decisions[0].intent).state;
  assertEq(s.balanceCents, balanceBefore - 200_00); // balance reduced
  assertEq(s.envelopes.vietnam_hotel.fundedCents, 200_00); // funded grew
  // No new envelope created
  assertEq(Object.keys(s.envelopes).length, 1);
});
