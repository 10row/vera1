"use strict";
// SCENARIO 6: User cancels a confirm card. State should NOT change.
module.exports = {
  name: "06-cancel-confirm",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 1st" },
    { type: "text", text: "spent 200 on groceries" },
    { type: "tap", match: /cancel|no/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000, // unchanged
    minTransactions: 1, // just setup
  },
};
