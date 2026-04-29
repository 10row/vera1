"use strict";
// SCENARIO 10: Russian-speaking user. Onboarding must be in Russian throughout.
module.exports = {
  name: "10-russian-onboarding",
  user: { language_code: "ru" },
  steps: [
    { type: "text", text: "привет" },
    { type: "text", text: "5000" },
    { type: "text", text: "15-го" },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 500000,
    paydayPattern: /-15$/,
    // Critical: NO English words in any bot reply.
    requirePhrases: [], // any one of these (locale check happens in judge)
    forbidPhrases: [/Hey 👋/i, /balance in your main account/i, /payday/],
  },
};
