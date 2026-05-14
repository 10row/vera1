"use strict";
// SCENARIO 15: Mark-as-paid must not leave the bill in two sections.
//
// THE BUG: a one-time bill marked paid in the mini app appeared in
// BOTH "Coming up / Overdue" AND "Paid this cycle", labeled as
// "overdue" even though just paid.
//
// ROOT: three forgetful UI readers ignored paidThisCycle. Fix: one
// canonical uiStatus field, every UI reader uses it.
//
// MARK-PAID PATH: the mini app sends a record_spend with billKey via
// POST /api/v5/apply. That's NOT the chat path — so the deep uiStatus
// invariant ("paid bill never has uiStatus=overdue/due_*") is tested
// in bills-uistatus.test.js (which mutates state directly through
// engine.applyIntent — same code path the API hits).
//
// This harness scenario covers the chat-side smoke test: bill gets
// added, bot doesn't lie about urgency in the next status update.
module.exports = {
  name: "15-mark-paid-no-double-show",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 25th" },
    { type: "text", text: "dry cleaning bill 85 due today" },
    { type: "text", text: "today" },
    { type: "tap", match: /yes|log|sav|подтв|reserv/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    bills: ["dry_cleaning"],
  },
};
