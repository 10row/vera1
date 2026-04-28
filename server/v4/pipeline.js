"use strict";
// v4/pipeline.js — orchestration. AI parser → validator → typed result.
// Pure with respect to state. Returns what the bot should DO; bot decides UI.

const { parseProposal } = require("./ai");
const { validateBatch, validateIntent } = require("./validator");
const { simulate } = require("./view");
const m = require("./model");

// Outcome shapes:
//   { kind: "talk",     message }
//   { kind: "decision", message, intent, simulate }   ← decision support
//   { kind: "do",       message, decisions: [{ intent, verdict }] }
//
// verdict.severity: "auto" | "confirm" | "reject".
// Bot loop:
//   - talk     → send message
//   - decision → show projected hero + delta, "Log it now" button
//   - do/reject  → tell user the reason
//   - do/auto    → applyIntent now, show "Logged" + Undo
//   - do/confirm → show inline keyboard, apply on Yes
async function processMessage(state, userMessage, history, options) {
  const proposal = await parseProposal(state, userMessage, history, options);
  if (proposal.mode === "talk" || proposal.intents.length === 0) {
    return {
      kind: "talk",
      message: proposal.message,
      warnings: proposal.warnings || [],
    };
  }

  // Decision support: a single simulate_spend intent is special — it's
  // read-only. Bypass engine entirely; run view.simulate() and return
  // a "decision" result that the bot formats with hero + delta.
  if (proposal.intents.length === 1 && proposal.intents[0].kind === "simulate_spend") {
    const intent = proposal.intents[0];
    const todayStr = m.today((state && state.timezone) || "UTC");
    const verdict = validateIntent(state, intent, todayStr);
    if (!verdict.ok) {
      return {
        kind: "do",
        message: proposal.message,
        decisions: [{ intent, verdict }],
        warnings: proposal.warnings || [],
      };
    }
    const sim = simulate(state, intent.params, todayStr);
    return {
      kind: "decision",
      message: proposal.message,
      intent,
      simulate: sim,
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
