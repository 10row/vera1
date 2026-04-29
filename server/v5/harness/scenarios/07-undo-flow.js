"use strict";
// SCENARIO 7: User logs spend, taps Yes, then taps Undo. Balance restored.
module.exports = {
  name: "07-undo-flow",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 25th" },
    { type: "text", text: "spent 80 on groceries" },
    { type: "tap", match: /yes/i },
    { type: "tap", match: /undo/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000, // back to original
  },
};
