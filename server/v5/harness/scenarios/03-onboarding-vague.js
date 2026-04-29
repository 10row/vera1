"use strict";
// SCENARIO 3: Vague user. Greets first. Sends gibberish. Eventually gives a number.
module.exports = {
  name: "03-onboarding-vague",
  description: "Hesitant user dodges before answering. Bot must NOT loop, MUST stay patient.",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "hi" },
    { type: "text", text: "what does this do?" },
    { type: "text", text: "ok" },
    { type: "text", text: "fine, around 3000" },
    { type: "text", text: "skip" },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 300000,
  },
};
