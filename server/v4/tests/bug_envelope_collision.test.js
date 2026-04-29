"use strict";
// Regression test — user reported:
//   "I have $1000 for Vietnam hotel. I tried to put $700 away for my trip
//    and it says 'that name is already in use' and won't allow it."
//
// Root: validator's add_envelope rejected on key collision regardless of
// whether the existing envelope was active or inactive, and the rejection
// reason gave no hint at the fix. Plus there was no fund_envelope intent
// in v4 at all, so the AI had no clean way to "put X toward existing Y".

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");

const TODAY = "2025-04-28";

function setupWithVietnamHotel() {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 1000_00 },
  }).state;
  return s;
}

// ── HELPFUL REJECTION on active duplicate ─────────
test("[BUG] add_envelope on EXISTING active envelope: helpful rejection mentions name + amount", () => {
  const s = setupWithVietnamHotel();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 700_00 },
  }, TODAY);
  assertEq(v.ok, false);
  assertTrue(/Vietnam Hotel/i.test(v.reason), "rejection should mention the existing name");
  assertTrue(/\$1,000/.test(v.reason), "rejection should mention existing amount");
  assertTrue(/different name|update/i.test(v.reason), "rejection should hint at next step");
});

// ── INACTIVE envelope: re-creation IS allowed ──────
test("[BUG] add_envelope after remove_envelope works (inactive doesn't block reuse)", () => {
  let s = setupWithVietnamHotel();
  s = applyIntent(s, { kind: "remove_envelope", params: { name: "Vietnam Hotel" } }).state;
  // Now should be allowed
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 700_00 },
  }, TODAY);
  assertEq(v.ok, true);
  // And the engine accepts it
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 700_00 },
  }).state;
  assertEq(s.envelopes.vietnam_hotel.active, true);
  assertEq(s.envelopes.vietnam_hotel.amountCents, 700_00);
});

// ── DIFFERENT name passes ─────────────────────────
test("[BUG] add_envelope with a different name (Vietnam Trip vs Vietnam Hotel) works", () => {
  const s = setupWithVietnamHotel();
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Trip", kind: "goal", amountCents: 700_00 },
  }, TODAY);
  assertEq(v.ok, true);
});

// ── fund_envelope intent: the proper path for "put X toward Y" ──
test("[BUG] fund_envelope on existing goal moves money from balance to fundedCents", () => {
  let s = setupWithVietnamHotel();
  const balanceBefore = s.balanceCents;
  s = applyIntent(s, {
    kind: "fund_envelope",
    params: { name: "Vietnam Hotel", amountCents: 700_00 },
  }).state;
  assertEq(s.balanceCents, balanceBefore - 700_00);
  assertEq(s.envelopes.vietnam_hotel.fundedCents, 700_00);
});

test("[BUG] fund_envelope validator rejects on phantom envelope", () => {
  const s = setupWithVietnamHotel();
  const v = validateIntent(s, {
    kind: "fund_envelope",
    params: { name: "Ghost", amountCents: 100_00 },
  }, TODAY);
  assertEq(v.ok, false);
});

test("[BUG] fund_envelope validator rejects negative amount", () => {
  const s = setupWithVietnamHotel();
  const v = validateIntent(s, {
    kind: "fund_envelope",
    params: { name: "Vietnam Hotel", amountCents: -50_00 },
  }, TODAY);
  assertEq(v.ok, false);
});

test("[BUG] fund_envelope > balance triggers explicit confirm warning", () => {
  const s = setupWithVietnamHotel();
  const v = validateIntent(s, {
    kind: "fund_envelope",
    params: { name: "Vietnam Hotel", amountCents: 6_000_00 },
  }, TODAY);
  assertEq(v.ok, true);
  assertEq(v.severity, "confirm");
  assertTrue(/balance/i.test(v.reason));
});

// ── undo round-trip preserves invariants ──────────
test("[BUG] fund_envelope is undoable byte-perfectly", () => {
  let s = setupWithVietnamHotel();
  const before = JSON.stringify(s);
  s = applyIntent(s, {
    kind: "fund_envelope",
    params: { name: "Vietnam Hotel", amountCents: 700_00 },
  }).state;
  s = applyIntent(s, { kind: "undo_last", params: {} }).state;
  // balance, envelope state must match
  assertEq(s.balanceCents, JSON.parse(before).balanceCents);
  assertEq(s.envelopes.vietnam_hotel.fundedCents, JSON.parse(before).envelopes.vietnam_hotel.fundedCents);
});
