"use strict";
// SCENARIO 2: Brain-dump onboarding — user gives both balance and payday in one msg.
module.exports = {
  name: "02-onboarding-dump",
  description: "User dumps everything in one message. Should set up in ONE turn.",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "Hey, I have about 5000 in my account and I get paid the 15th of each month" },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000,
    paydayPattern: /-15$/,
    minTurns: 1, // bot should NOT have asked any extra questions
  },
};
