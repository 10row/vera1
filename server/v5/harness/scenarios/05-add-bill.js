"use strict";
// SCENARIO 5: Adding a recurring bill — must include recurrence, not be wiped on first payment.
module.exports = {
  name: "05-add-bill",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 25th" },
    { type: "text", text: "rent is 1400 due the 1st" },
    { type: "tap", match: /yes/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000, // adding a bill doesn't touch balance
    bills: ["rent"],
  },
};
