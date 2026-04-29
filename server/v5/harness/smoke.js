"use strict";
// Smoke test: run one onboarding scenario, print the transcript.
// node server/v5/harness/smoke.js

require("dotenv").config({ override: true });
const { runScenario } = require("./driver");

(async () => {
  const result = await runScenario({
    name: "smoke-onboard",
    user: { language_code: "en" },
    steps: [
      { type: "command", command: "start" },
      { type: "text", text: "5000" },
      { type: "text", text: "the 15th" },
      { type: "text", text: "I spent 25 on coffee" },
      { type: "tap", match: /yes/i },
      { type: "text", text: "rent is 1400 due the 1st" },
      { type: "tap", match: /yes/i },
      { type: "command", command: "today" },
    ],
  }, { log: false });

  console.log("=".repeat(60));
  console.log("SCENARIO: " + result.name);
  console.log("=".repeat(60));
  console.log(result.rendered);
  console.log("\n=== final state ===");
  console.log(JSON.stringify({
    setup: result.finalState && result.finalState.setup,
    balance: result.finalState && result.finalState.balanceCents,
    payday: result.finalState && result.finalState.payday,
    bills: result.finalState && Object.keys(result.finalState.bills || {}),
    eventCount: result.finalState && (result.finalState.events || []).length,
  }, null, 2));
})();
