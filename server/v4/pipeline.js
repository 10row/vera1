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

// Deterministic rewrite: when state.setup is true and the AI emits a
// setup_account intent (which it shouldn't, but gpt-4o-mini occasionally
// does), translate it into the right adjust_balance and/or
// update_settings intents based on what's actually different from the
// current state. The user never sees an "already set up" rejection.
//
// This is the structural fix for the most-reported bug: paycheck info
// landing as setup_account on an already-setup account.
function rewriteSetupOnAlreadySetup(state, intents) {
  if (!state || !state.setup) return intents;
  const out = [];
  for (const intent of intents) {
    if (!intent || intent.kind !== "setup_account") {
      out.push(intent);
      continue;
    }
    const p = intent.params || {};
    // Balance → adjust_balance (only if it's a real change)
    if (typeof p.balanceCents === "number"
        && Number.isFinite(p.balanceCents)
        && p.balanceCents !== state.balanceCents) {
      out.push({
        kind: "adjust_balance",
        params: { newBalanceCents: p.balanceCents, note: "balance update" },
      });
    }
    // Schedule / locale fields → update_settings (only if changed)
    const settings = {};
    if (p.payday && p.payday !== state.payday) settings.payday = p.payday;
    if (p.payFrequency && p.payFrequency !== state.payFrequency) settings.payFrequency = p.payFrequency;
    if (p.timezone && p.timezone !== state.timezone) settings.timezone = p.timezone;
    if (p.currency && p.currency !== state.currency) settings.currency = p.currency;
    if (p.currencySymbol && p.currencySymbol !== state.currencySymbol) settings.currencySymbol = p.currencySymbol;
    if (p.language && p.language !== state.language) settings.language = p.language;
    if (Object.keys(settings).length > 0) {
      out.push({ kind: "update_settings", params: settings });
    }
    // If nothing to update (AI re-emitted setup with identical state),
    // silently drop. The user's message will be handled in TALK mode by
    // the AI's reply text — no rejection card.
  }
  return out;
}

async function processMessage(state, userMessage, history, options) {
  const proposal = await parseProposal(state, userMessage, history, options);
  // pendingQuestion travels through every result shape so the bot can
  // persist it onto state after each turn (or clear it).
  const pq = proposal.pendingQuestion || null;

  if (proposal.mode === "talk" || proposal.intents.length === 0) {
    return {
      kind: "talk",
      message: proposal.message,
      pendingQuestion: pq,
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
        pendingQuestion: pq,
        warnings: proposal.warnings || [],
      };
    }
    const sim = simulate(state, intent.params, todayStr);
    return {
      kind: "decision",
      message: proposal.message,
      intent,
      simulate: sim,
      pendingQuestion: pq,
      warnings: proposal.warnings || [],
    };
  }

  // Cap queue size as a defensive measure
  let intents = proposal.intents.slice(0, MAX_QUEUE);

  // INTENT REWRITER: if AI emitted setup_account on an already-setup
  // user (despite the prompt rule), rewrite it deterministically into
  // adjust_balance + update_settings as appropriate. The user never sees
  // an "already set up" rejection.
  intents = rewriteSetupOnAlreadySetup(state, intents);

  // After rewrite the batch may be empty (e.g. AI emitted only a no-op
  // setup_account). Fall back to talk-mode reply.
  if (intents.length === 0) {
    return {
      kind: "talk",
      message: proposal.message,
      pendingQuestion: pq,
      warnings: proposal.warnings || [],
    };
  }

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
      pendingQuestion: pq,
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
    pendingQuestion: pq,
    warnings: proposal.warnings || [],
  };
}

module.exports = { processMessage };
