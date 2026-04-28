"use strict";
// v4/pipeline.js — orchestration. AI parser → validator → typed result.
// Pure with respect to state. Returns what the bot should DO; bot decides UI.

const { parseProposal } = require("./ai");
const { validateBatch } = require("./validator");
const m = require("./model");

// Outcome:
//   { kind: "talk", message }
//   { kind: "do",   message, decisions: [{ intent, verdict }] }
//
// verdict.severity is "auto" | "confirm" | "reject".
// Bot loop:
//   - reject  → tell user the reason, do nothing
//   - auto    → applyIntent now, show "Logged" + Undo
//   - confirm → show inline keyboard, apply on Yes
async function processMessage(state, userMessage, history, options) {
  const proposal = await parseProposal(state, userMessage, history, options);
  if (proposal.mode === "talk" || proposal.intents.length === 0) {
    return {
      kind: "talk",
      message: proposal.message,
      warnings: proposal.warnings || [],
    };
  }
  const todayStr = m.today((state && state.timezone) || "UTC");
  const verdicts = validateBatch(state, proposal.intents, todayStr);
  // If validateBatch returned a single rejection (cascade attack), align the result.
  if (verdicts.length === 1 && proposal.intents.length > 1) {
    return {
      kind: "do",
      message: proposal.message,
      decisions: [{ intent: null, verdict: verdicts[0] }],
      warnings: proposal.warnings || [],
    };
  }
  const decisions = proposal.intents.map((intent, i) => ({
    intent,
    verdict: verdicts[i] || { ok: false, severity: "reject", reason: "missing verdict" },
  }));
  return {
    kind: "do",
    message: proposal.message,
    decisions,
    warnings: proposal.warnings || [],
  };
}

module.exports = { processMessage };
