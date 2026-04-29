"use strict";
// SCENARIO 12: User voice-notes / brain-dumps everything in one message.
// The bot should: 1) finish setup, 2) NOT lose the bill they mentioned.
// Real-world failure mode reported by the user.
module.exports = {
  name: "12-onboarding-braindump",
  description: "Voice-note style brain dump — balance, payday, AND a bill in one message. Bot must capture all of it.",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "Hey so I have about 5000 in my account, I get paid the 15th of each month, and rent is 1400 due the 1st" },
    // Setup applies first. Then the bot re-routes this message to AI →
    // confirm card for rent appears. User taps Yes.
    { type: "tap", match: /yes/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000,
    paydayPattern: /-15$/,
    bills: ["rent"], // critical: rent must NOT be lost
  },
};
