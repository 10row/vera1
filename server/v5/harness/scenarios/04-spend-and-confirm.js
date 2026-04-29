"use strict";
// SCENARIO 4: Onboard + record a spend + tap Yes. Confirm flow + balance update.
module.exports = {
  name: "04-spend-and-confirm",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "I have 5000 paid the 1st of each month" },
    { type: "text", text: "I spent 25 on coffee this morning" },
    { type: "tap", match: /yes/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 497500, // 5000.00 - 25.00 = 4975.00 → 497500 cents
    minTransactions: 2,   // setup tx + spend
  },
};
