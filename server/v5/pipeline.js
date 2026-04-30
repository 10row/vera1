"use strict";
// v5/pipeline.js — orchestrate one user message into one outcome.
//
// Outcome shapes (returned to bot):
//   { kind: "onboarding", reply, intent?, draft?, clearDraft?, done }
//   { kind: "talk", message }
//   { kind: "do", message, intent, verdict }
//   { kind: "do_batch", message, items: [{intent, verdict}, ...] }   // brain-dump
//   { kind: "decision", message, simulate }     // "can I afford X"
//
// Pipeline NEVER mutates state. Bot applies intents after the user confirms.

const m = require("./model");
const { parseProposal } = require("./ai");
const { validateIntent } = require("./validator");
const { simulateSpend } = require("./view");
const onboarding = require("./onboarding");

async function processMessage(state, userMessage, history, options) {
  // ── PHASE 1: deterministic onboarding while !setup ──
  if (!state || !state.setup) {
    const todayStr = m.today((state && state.timezone) || "UTC");
    const decision = onboarding.handle(state, userMessage, todayStr);
    return {
      kind: "onboarding",
      reply: decision.reply,
      intent: decision.intent || null,
      draft: decision.draft || null,
      clearDraft: !!decision.clearDraft,
      done: !!decision.done,
    };
  }

  // ── PHASE 2: AI for everything else ──
  const proposal = await parseProposal(state, userMessage, history, options);

  if (proposal.mode === "ask_simulate") {
    const sim = simulateSpend(state, proposal.amountCents);
    return {
      kind: "decision",
      message: proposal.message,
      amountCents: proposal.amountCents,
      simulate: sim,
    };
  }

  if (proposal.mode === "do" && proposal.intent) {
    const todayStr = m.today((state && state.timezone) || "UTC");
    const verdict = validateIntent(state, proposal.intent, todayStr);
    return {
      kind: "do",
      message: proposal.message,
      intent: proposal.intent,
      verdict,
    };
  }

  // do_batch: 2-5 intents from a brain dump. Validate each independently
  // against the SAME state snapshot (we don't simulate sequencing here —
  // the bot applies them in order under one lock and reports failures).
  if (proposal.mode === "do_batch" && Array.isArray(proposal.intents) && proposal.intents.length > 0) {
    const todayStr = m.today((state && state.timezone) || "UTC");
    const items = proposal.intents.map(intent => ({
      intent,
      verdict: validateIntent(state, intent, todayStr),
    }));
    return {
      kind: "do_batch",
      message: proposal.message,
      items,
    };
  }

  // talk fallback
  return {
    kind: "talk",
    message: proposal.message || "…",
  };
}

module.exports = { processMessage };
