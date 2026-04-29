"use strict";
// SCENARIO 11: Typo-heavy user. "i spnet 25 on cofee" / "got 3k pay chek". Bot should still get it.
module.exports = {
  name: "11-typos",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "5k bal pay 1st" },
    { type: "text", text: "spnet 25 on cofee" },
    { type: "tap", match: /yes/i },
    { type: "text", text: "got 3000 pay chek" },
    { type: "tap", match: /yes/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    balanceCents: 797500, // 5000 - 25 + 3000 = 7975
  },
};
