"use strict";
// SCENARIO 14: The dry-cleaning clarify loop (bug-report 0007).
//
// User: "dry cleaning tomorrow morning its 3150 thb"
// (AI is non-deterministic about the date — sometimes drops it, then
//  the validator clarifies)
// Bot: "by when?"
// User: "tomorrow"
// Bot: must accept it. NOT loop back to "by when?".
//
// This regression locks in the pendingDraft mechanism. Even when the
// AI drops the date, the deterministic resolver merges "tomorrow"
// into the pending add_bill and ships the confirm card.
module.exports = {
  name: "14-clarify-loop-dry-cleaning",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "I have 5000 paid the 1st of each month" },
    // Use "need to pay X" — unambiguous future commitment, triggers
    // add_bill not record_spend. AI may or may not pick up the date.
    // Either way: if the AI emits add_bill with dueDate, we go straight
    // to confirm. If the AI drops the dueDate, the validator clarifies
    // and pendingDraft holds the partial intent. "tomorrow" then
    // resolves deterministically.
    { type: "text", text: "need to pay dry cleaning 3150 thb" },
    // Defensive: if the AI already included a dueDate, this "tomorrow"
    // line is a no-op (no clarify pending). If it asked, this resolves.
    { type: "text", text: "tomorrow" },
    { type: "tap", match: /yes|log|sav|подтв/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    // Balance unchanged — add_bill doesn't touch balance.
    balanceCents: 500000,
    // billKey format is underscored.
    bills: ["dry_cleaning"],
  },
};
