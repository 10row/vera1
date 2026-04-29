"use strict";
// SCENARIO 1: Clean onboarding (the happy path).
module.exports = {
  name: "01-onboarding-clean",
  description: "Fresh user types balance and payday clearly. Should be set up in 3 turns.",
  user: { language_code: "en" },
  steps: [
    { type: "command", command: "start" },
    { type: "text", text: "5000" },
    { type: "text", text: "the 15th" },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000,
    paydayPattern: /-15$/, // payday ends on day 15
  },
};
