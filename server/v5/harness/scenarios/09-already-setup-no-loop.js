"use strict";
// SCENARIO 9 — THE KILLER: post-setup, the AI must NEVER say "setting up your account"
// or emit setup_account. This is the bug class that triggered the v5 rebuild.
module.exports = {
  name: "09-already-setup-no-loop",
  description: "After setup, sending 'setup my account' or 'I have $5000' must NOT loop.",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5000 paid the 1st" },
    { type: "text", text: "set up my account again" },
    { type: "text", text: "I have like 5000" },
    { type: "text", text: "actually I have 7000 now" },
    // The third message should be interpreted as adjust_balance, not setup_account.
    { type: "tap", match: /yes/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 700000,
    // Critical: every assistant message must NOT contain "setting up" or "set up your account"
    forbidPhrases: [/setting up/i, /set up your account/i, /set you up/i],
  },
};
