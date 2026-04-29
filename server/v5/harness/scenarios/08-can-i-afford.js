"use strict";
// SCENARIO 8: Decision support — "can I afford X?" must NOT be a record_spend.
// State must NOT change.
module.exports = {
  name: "08-can-i-afford",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 25th" },
    { type: "text", text: "Can I afford a $200 jacket?" },
    // After ask_simulate, bot offers a "Log it now" button.
    // We tap "No / Skip" so state stays.
    { type: "tap", match: /no|skip/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000, // unchanged — was a hypothetical
  },
};
