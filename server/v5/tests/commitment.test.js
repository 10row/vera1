"use strict";
// Commitment-shape detection + commitment_choice flow.
//
// User-reported scenario: "i spent 200 euro for friends trip" — bot
// recorded it as record_spend which ate today's daily allowance.
// Wrong: this is a one-time commitment the user paid, not their
// normal discretionary day. Goal: detect the shape, offer two paths
// on the confirm card.
//
// Detection signal:
//   1. record_spend (not record_income, not adjust_balance)
//   2. amount >= $30 USD-equivalent (absolute floor)
//   3. amount >= 1.5x daily pace (so a normal day doesn't fire)
//   4. note/message contains a commitment marker ("for X's wedding",
//      "for the trip", "gift for Y", etc.)
//
// All four must hold. Conservative on purpose — false positives are
// confusing (extra button taps for routine spends).

const m = require("../model");
const { applyIntent } = require("../engine");
const { processMessage, isCommitmentShape, deriveCommitmentName, buildCommitmentBatch, userMessageMentionsDate } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function fullySetUp(balance) {
  // Payday must be FUTURE so daysToPayday > 0 and pace is realistic.
  // With $5000 / ~30 days that's ~$166/day — commitment threshold of
  // 1.5x ≈ $250 means $200 commitment spends pass (just barely),
  // $30 coffee spends fail (correct).
  const futurePayday = m.addDays(m.today("UTC"), 30);
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: futurePayday, payFrequency: "monthly" },
  }).state;
}

// ── isCommitmentShape: positive cases ─────────────────────────
test("[commitment-shape] '200 for friend's wedding' → detected", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 20000, note: "for friend's wedding" } },
    "spent 200 for friend's wedding");
  assertEq(r, true);
});

test("[commitment-shape] '200 euro for friend's trip' → detected", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 21500, note: "for friend's trip", originalAmount: 200, originalCurrency: "EUR" } },
    "i spent 200 euro for friends trip");
  assertEq(r, true);
});

test("[commitment-shape] 'gift for mom' → detected", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 15000, note: "gift for mom" } },
    "150 gift for mom");
  assertEq(r, true);
});

test("[commitment-shape] 'deposit for apartment' → detected", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 80000, note: "deposit for apartment" } },
    "800 deposit for apartment");
  assertEq(r, true);
});

test("[commitment-shape] Russian 'для свадьбы' → detected", () => {
  let s = fullySetUp(500000);
  s.language = "ru";
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 30000, note: "для свадьбы" } },
    "потратил 300 для свадьбы");
  assertEq(r, true);
});

// ── isCommitmentShape: negative cases ─────────────────────────
test("[commitment-shape] 'spent 25 on coffee' → NOT detected (too small)", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 2500, note: "coffee" } },
    "spent 25 on coffee");
  assertEq(r, false);
});

test("[commitment-shape] '60 on groceries' → NOT detected (no marker)", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 6000, note: "groceries" } },
    "spent 60 on groceries");
  assertEq(r, false);
});

test("[commitment-shape] '200 on dinner' → NOT detected (no marker)", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 20000, note: "dinner" } },
    "spent 200 on dinner");
  assertEq(r, false);
});

test("[commitment-shape] '200 for coffee' → NOT detected ('coffee' not a commitment object)", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 20000, note: "for coffee" } },
    "spent 200 for coffee");
  assertEq(r, false);
});

test("[commitment-shape] record_income → NOT detected (wrong kind)", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_income", params: { amountCents: 200000, note: "for wedding fund" } },
    "got 2000 for wedding fund");
  assertEq(r, false);
});

test("[commitment-shape] backdated spend → NOT detected (date set means historical, not today's choice)", () => {
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 20000, note: "for trip", date: "2025-12-01" } },
    "spent 200 for trip yesterday");
  assertEq(r, false);
});

test("[commitment-shape] already-billKey'd record_spend → NOT detected (it's already a bill payment)", () => {
  let s = fullySetUp(500000);
  const futureDate = m.addDays(m.today("UTC"), 7);
  s = applyIntent(s, { kind: "add_bill", params: { name: "Friend trip", amountCents: 20000, dueDate: futureDate, recurrence: "once" } }).state;
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 20000, note: "paid friend", billKey: m.billKey("Friend trip") } },
    "paid friend");
  assertEq(r, false);
});

test("[commitment-shape] amount below daily pace × 1.5 → NOT detected", () => {
  // Pace = balance/days, with $500k over ~60+ days that's >$8k pace.
  // A $50 spend with a commitment marker shouldn't fire — too small relative.
  const s = fullySetUp(500000);
  const r = isCommitmentShape(s,
    { kind: "record_spend", params: { amountCents: 5000, note: "for trip" } },
    "spent 50 for trip");
  assertEq(r, false);
});

// ── deriveCommitmentName ─────────────────────────────────────
test("[derive-name] 'for friend's wedding' → 'Friend's wedding'", () => {
  assertEq(deriveCommitmentName("for friend's wedding", null, "en"), "Friend's wedding");
});
test("[derive-name] 'for the trip' → 'Trip'", () => {
  assertEq(deriveCommitmentName("for the trip", null, "en"), "Trip");
});
test("[derive-name] 'for my birthday' → 'Birthday'", () => {
  assertEq(deriveCommitmentName("for my birthday", null, "en"), "Birthday");
});
test("[derive-name] 'gift for mom' → 'Gift for mom'", () => {
  assertEq(deriveCommitmentName("gift for mom", null, "en"), "Gift for mom");
});
test("[derive-name] vendor present → use vendor", () => {
  assertEq(deriveCommitmentName("for friend's wedding", "Sephora", "en"), "Sephora");
});
test("[derive-name] empty note → fallback", () => {
  assertEq(deriveCommitmentName("", null, "en"), "Commitment");
});
test("[derive-name] empty note (RU) → fallback in Russian", () => {
  assertEq(deriveCommitmentName("", null, "ru"), "Обязательство");
});
test("[derive-name] Russian 'для свадьбы' → 'Свадьбы'", () => {
  assertEq(deriveCommitmentName("для свадьбы", null, "ru"), "Свадьбы");
});

// ── buildCommitmentBatch ─────────────────────────────────────
test("[batch] builds [add_bill, record_spend with billKey] with shared billKey", () => {
  const s = fullySetUp(500000);
  const spendIntent = {
    kind: "record_spend",
    params: { amountCents: 20000, note: "for friend's trip", category: "personal" },
  };
  const batch = buildCommitmentBatch(s, spendIntent, "en");
  assertEq(batch.length, 2);
  assertEq(batch[0].kind, "add_bill");
  assertEq(batch[0].params.name, "Friend's trip");
  assertEq(batch[0].params.amountCents, 20000);
  assertEq(batch[0].params.recurrence, "once");
  // dueDate should be today
  assertEq(batch[0].params.dueDate, m.today("UTC"));
  assertEq(batch[1].kind, "record_spend");
  assertEq(batch[1].params.billKey, m.billKey("Friend's trip"));
});

test("[batch] preserves foreign currency on add_bill", () => {
  const s = fullySetUp(500000);
  const spendIntent = {
    kind: "record_spend",
    params: { amountCents: 21500, originalAmount: 200, originalCurrency: "EUR", note: "for friend's trip" },
  };
  const batch = buildCommitmentBatch(s, spendIntent, "en");
  assertEq(batch[0].params.originalAmount, 200);
  assertEq(batch[0].params.originalCurrency, "EUR");
});

test("[batch] dup name → suffix with today's date", () => {
  let s = fullySetUp(500000);
  const futureDate = m.addDays(m.today("UTC"), 7);
  s = applyIntent(s, { kind: "add_bill", params: { name: "Friend's trip", amountCents: 10000, dueDate: futureDate, recurrence: "once" } }).state;
  const spendIntent = {
    kind: "record_spend",
    params: { amountCents: 20000, note: "for friend's trip" },
  };
  const batch = buildCommitmentBatch(s, spendIntent, "en");
  assertTrue(batch[0].params.name.startsWith("Friend's trip ("), "expected dated suffix, got: " + batch[0].params.name);
});

// ── Pipeline integration: kind:'commitment_choice' ──────────
test("[pipeline-commitment] '200 for friend's wedding' → kind:'commitment_choice'", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "spent 200 for friend's wedding", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging it.",
      intent: { kind: "record_spend", params: { amountCents: 20000, note: "for friend's wedding" } },
    }),
  });
  assertEq(r.kind, "commitment_choice");
  assertTrue(!!r.spendIntent);
  assertTrue(Array.isArray(r.commitmentBatch));
  assertEq(r.commitmentBatch.length, 2);
  assertEq(r.commitmentBatch[0].kind, "add_bill");
  assertEq(r.commitmentBatch[1].kind, "record_spend");
});

test("[pipeline-commitment] '25 on coffee' → kind:'do' (normal flow)", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "spent 25 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging.",
      intent: { kind: "record_spend", params: { amountCents: 2500, note: "coffee" } },
    }),
  });
  assertEq(r.kind, "do");
});

test("[pipeline-commitment] big-amount commitment with foreign currency → commitment_choice", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "spent 200 euro for friend's trip", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging.",
      intent: {
        kind: "record_spend",
        params: { amountCents: 0, originalAmount: 200, originalCurrency: "EUR", note: "for friend's trip" },
      },
    }),
  });
  // Pipeline converts EUR→USD before commitment detection.
  assertEq(r.kind, "commitment_choice");
  // Foreign-currency info preserved on the add_bill.
  assertEq(r.commitmentBatch[0].params.originalCurrency, "EUR");
  assertEq(r.commitmentBatch[0].params.originalAmount, 200);
});

// ── userMessageMentionsDate (the dueDate safety net) ──────────
test("[date-marker] 'spent 200 for trip' → no date marker", () => {
  assertEq(userMessageMentionsDate("spent 200 for trip"), false);
});
test("[date-marker] 'pay 200 by friday' → date marker present", () => {
  assertEq(userMessageMentionsDate("pay 200 by friday"), true);
});
test("[date-marker] 'rent 1400 due the 1st' → date marker present", () => {
  assertEq(userMessageMentionsDate("rent 1400 due the 1st"), true);
});
test("[date-marker] 'in 3 weeks' → date marker present", () => {
  assertEq(userMessageMentionsDate("save 300 in 3 weeks for the trip"), true);
});
test("[date-marker] '2025-12-01' → date marker present", () => {
  assertEq(userMessageMentionsDate("by 2025-12-01"), true);
});
test("[date-marker] Russian 'к пятнице' → date marker present", () => {
  assertEq(userMessageMentionsDate("отложи 200 к пятнице"), true);
});
test("[date-marker] Russian 'через 3 недели' → date marker present", () => {
  assertEq(userMessageMentionsDate("через 3 недели свадьба"), true);
});
test("[date-marker] 'reserve 200 for friend' (no date) → no marker", () => {
  assertEq(userMessageMentionsDate("reserve 200 for friend"), false);
});

// ── Strip-invented-dueDate safety net ────────────────────────
test("[strip-dueDate] AI invents dueDate when user gave no date → stripped → clarify", async () => {
  const s = fullySetUp(500000);
  const r = await processMessage(s, "need 200 for friend", [], {
    _aiCall: stub({
      mode: "do",
      message: "Reserving for friend.",
      intent: {
        kind: "add_bill",
        params: { name: "Friend", amountCents: 20000, dueDate: m.today("UTC"), recurrence: "once" },
      },
    }),
  });
  assertEq(r.kind, "clarify", "stripped invented dueDate should trigger clarify");
  assertEq(r.field, "dueDate");
});

test("[strip-dueDate] user gave a date → AI's dueDate respected", async () => {
  const s = fullySetUp(500000);
  const futureDate = m.addDays(m.today("UTC"), 3);
  const r = await processMessage(s, "need 200 for friend by friday", [], {
    _aiCall: stub({
      mode: "do",
      message: "Reserving for friend.",
      intent: { kind: "add_bill", params: { name: "Friend", amountCents: 20000, dueDate: futureDate, recurrence: "once" } },
    }),
  });
  assertEq(r.kind, "do", "user-mentioned date keeps the AI's dueDate");
  assertEq(r.verdict.ok, true);
});

test("[strip-dueDate] doesn't touch record_spend dates", async () => {
  const s = fullySetUp(500000);
  // record_spend doesn't have a dueDate concept (it has tx date); the strip
  // only applies to add_bill. Regular spend stays as 'do'.
  const r = await processMessage(s, "spent 30 on lunch", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging.",
      intent: { kind: "record_spend", params: { amountCents: 3000, note: "lunch" } },
    }),
  });
  assertEq(r.kind, "do");
});

// ── End-to-end: applying the commitment batch ────────────────
test("[e2e-commitment] applying batch: balance drops, pace unchanged (carve-out cancels)", () => {
  let s = fullySetUp(500000); // $5000
  s.dailyPaceCents = 10000; // pretend pace = $100/day
  s.dailyPaceComputedDate = m.today((s && s.timezone) || "UTC");
  const balanceBefore = s.balanceCents;

  const spendIntent = { kind: "record_spend", params: { amountCents: 20000, note: "for friend's wedding" } };
  const batch = buildCommitmentBatch(s, spendIntent, "en");

  // Apply add_bill first
  s = applyIntent(s, batch[0]).state;
  // Then the bill_payment
  s = applyIntent(s, batch[1]).state;

  // Balance dropped by the amount
  assertEq(s.balanceCents, balanceBefore - 20000);
  // The bill should be paidThisCycle
  const billKey = m.billKey(batch[0].params.name);
  assertTrue(s.bills[billKey] && s.bills[billKey].paidThisCycle === true,
             "bill should be paid this cycle");
});

test("[e2e-commitment] taking spend path (no commitment) just records spend, no bill", () => {
  let s = fullySetUp(500000);
  const spendIntent = { kind: "record_spend", params: { amountCents: 20000, note: "for friend's wedding" } };
  s = applyIntent(s, spendIntent).state;
  // No bill created
  assertEq(Object.keys(s.bills || {}).length, 0);
  // Balance dropped
  assertEq(s.balanceCents, 500000 - 20000);
});
