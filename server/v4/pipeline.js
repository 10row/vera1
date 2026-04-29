"use strict";
// v4/pipeline.js — orchestration layer.
// Translates one user message into a sequenced plan of confirmations.
//
// Outcome shapes:
//   { kind: "talk",     message }
//   { kind: "decision", message, intent, simulate }            ← read-only
//   { kind: "do",       message, decisions, queueAfter?, queueTotal? }
//
// THE ORCHESTRATION RULE:
//   When the user sends a comprehensive message ("$5790 balance, hotel 1000
//   tomorrow, paid 25th of 13k") the AI emits MULTIPLE intents. Rather than
//   rejecting the batch (which evaporates intents the user mentioned), we
//   present the FIRST intent now, queue the REST. Bot advances the queue
//   one confirm card at a time. User sees "2 of 3", "3 of 3", final summary.
//   Setup-must-be-solo is satisfied by sequencing, not by rejection.
//
// verdict.severity: "auto" | "confirm" | "reject".

const { parseProposal } = require("./ai");
const { validateBatch, validateIntent } = require("./validator");
const { simulate } = require("./view");
const m = require("./model");

const MAX_QUEUE = 5; // hard ceiling; AI sanitizer trims to 5 already.

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

  // Decision support: a single simulate_spend intent is special — it's
  // read-only. Bypass engine entirely; run view.simulate() and return
  // a "decision" result that the bot formats with hero + delta.
  if (proposal.intents.length === 1 && proposal.intents[0].kind === "simulate_spend") {
    const intent = proposal.intents[0];
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

  // Cap queue size as a defensive measure
  let intents = proposal.intents.slice(0, MAX_QUEUE);

  // ORCHESTRATION: setup_account always runs first. It MUST be solo at the
  // engine level (so we never have partial state from a setup + envelope
  // batch where envelope failed). When setup is in the batch alongside
  // others, lift it to the front and queue the rest after it.
  const setupIdx = intents.findIndex(i => i && i.kind === "setup_account");
  if (setupIdx > 0) {
    const setup = intents[setupIdx];
    intents = [setup].concat(intents.filter((_, i) => i !== setupIdx));
  }

  // SOLO INTENT: no orchestration needed
  if (intents.length === 1) {
    const verdicts = validateBatch(state, intents, todayStr);
    return {
      kind: "do",
      message: proposal.message,
      decisions: [{ intent: intents[0], verdict: verdicts[0] }],
      warnings: proposal.warnings || [],
    };
  }

  // MULTI-INTENT: present FIRST intent now, queue the REST. Bot advances
  // through the queue one confirm card at a time.
  const firstIntent = intents[0];
  const queueAfter = intents.slice(1);
  const firstVerdict = validateIntent(state, firstIntent, todayStr);
  return {
    kind: "do",
    message: proposal.message,
    decisions: [{ intent: firstIntent, verdict: firstVerdict }],
    queueAfter,
    queueTotal: intents.length,
    queueIndex: 1, // 1-based; the user sees "1 of N"
    warnings: proposal.warnings || [],
  };
}

module.exports = { processMessage };
