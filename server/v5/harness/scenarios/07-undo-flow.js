"use strict";
// SCENARIO 7: User logs spend, taps Yes, then taps Undo. Balance restored.
module.exports = {
  name: "07-undo-flow",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 25th" },
    { type: "text", text: "spent 80 on groceries" },
    { type: "tap", match: /yes|log/i },
    // Post-confirm card shows a text hint "_if this was a mistake,
    // type /undo_" rather than an inline button (linear/wise/mercury
    // tier — quiet UI, action via command). The scenario follows.
    { type: "command", command: "undo" },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000, // back to original
  },
};
