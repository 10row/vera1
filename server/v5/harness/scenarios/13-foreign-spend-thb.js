"use strict";
// SCENARIO 13: Foreign-currency spend (THB → base currency).
//
// Regression for bug-report 0006-mode-as-kind. Real user said "i just
// got a coffee and breakfast at plantiful 760thb" and saw "Hmm, didn't
// catch that" because the AI emitted {mode:"record_spend", params:{...}}
// instead of the canonical envelope. Defensive coercion in ai.js now
// rewrites the broken shape; this scenario locks in that a real foreign-
// currency spend produces a record_spend that lands.
module.exports = {
  name: "13-foreign-spend-thb",
  user: { language_code: "en" },
  steps: [
    { type: "text", text: "I have 5000 paid the 1st of each month" },
    { type: "text", text: "i just got a coffee and breakfast at plantiful 760thb" },
    { type: "tap", match: /yes|log/i },
    { type: "command", command: "today" },
  ],
  expect: {
    setup: true,
    minTransactions: 2, // setup tx + the THB spend
    // Balance is 5000 USD minus 760 THB (converted). Exact value
    // depends on FX rate at runtime, so we don't assert it. The key
    // signal is that the spend wasn't dropped — minTransactions
    // catches that.
  },
};
