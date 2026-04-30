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

// ── PROMISE-ACTION CONSISTENCY ────────────────────────────────
// THE silent-lie failure mode: AI's text says "I'll adjust your balance"
// but no adjust_balance intent is emitted. Bot ships the promise, nothing
// happens, user is confused. We detect this here and rewrite the reply
// to an honest "I'm not sure what to do — be more specific?" rather than
// shipping a lie.
//
// We're conservative: only catch UNAMBIGUOUS action verbs that should be
// paired with intents. False positives here would suppress legitimate
// chatty replies ("you'd be fine" is a simulation answer, not a promise).
const ACTION_VERBS = {
  // matchers → kind they require
  // Each entry: [regex, expected intent kinds (any of)]
  en: [
    [/\b(i'?ll|i will|i'?m|let me|going to)\s+(add|adding)\b/i, ["add_bill", "do_batch_add_bill"]],
    [/\b(i'?ll|i will|i'?m)\s+(log|logging|record|recording)\b/i, ["record_spend", "record_income"]],
    [/\b(i'?ll|i will|i'?m)\s+(adjust|adjusting|set|setting|chang|chang|updat)/i, ["adjust_balance", "update_payday"]],
    [/\b(i'?ll|i will|i'?m)\s+(remov|delet)/i, ["remove_bill"]],
    [/\b(undoing|reverting|i'?ll undo)/i, ["undo_last"]],
  ],
  ru: [
    [/\b(добавл|добавляю|записываю)/i, ["add_bill", "record_spend", "record_income"]],
    [/\b(исправл|поправл|меняю|корректирую)/i, ["adjust_balance", "update_payday"]],
    [/\b(удаля|убираю)/i, ["remove_bill"]],
    [/\b(отменяю|откатыв)/i, ["undo_last"]],
  ],
};

// Returns null if consistent. Returns rewritten honest reply if AI
// promised an action it didn't emit.
//
// IMPORTANT — when this fires:
//   - Mode `do` or `do_batch`: AI emitted intents, but its TEXT promised
//     an action that isn't covered by any of those intents.
//
// When it does NOT fire (deliberately):
//   - Mode `talk`: pure conversation; "I'll add support for that
//     feature" is meta, not a money-action promise.
//   - Mode `ask_simulate`: read-only by design.
//
// Tightened after persona test (Mike) — the looser version was firing
// on legit conversational replies and producing repeated "couldn't pin
// down" errors. False-positive cost was higher than false-negative.
function detectSilentLie(proposal, lang) {
  if (!proposal || !proposal.message) return null;
  if (proposal.mode !== "do" && proposal.mode !== "do_batch") return null;

  const text = proposal.message;
  const verbs = ACTION_VERBS[lang === "ru" ? "ru" : "en"] || ACTION_VERBS.en;

  const proposedKinds = new Set();
  if (proposal.intent && proposal.intent.kind) proposedKinds.add(proposal.intent.kind);
  if (Array.isArray(proposal.intents)) {
    for (const i of proposal.intents) if (i && i.kind) proposedKinds.add(i.kind);
  }
  // If there are no intents at all, this isn't a do/do_batch state per
  // contract — guard regardless.
  if (proposedKinds.size === 0) return null;

  for (const [re, expectedKinds] of verbs) {
    if (!re.test(text)) continue;
    const ok = expectedKinds.some(k => proposedKinds.has(k));
    if (!ok) {
      return lang === "ru"
        ? "_(хм, я сказал что сделаю, но не получилось. Попробуй переформулировать или уточнить — например указать сумму и дату.)_"
        : "_(I said I'd do it but couldn't pin down the exact action. Try again with the specific amount/date — e.g. \"adjust balance to 5000\" or \"log 25 on coffee\".)_";
    }
  }
  return null;
}

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
  const lang = state && state.language === "ru" ? "ru" : "en";

  // ── PROMISE-ACTION CHECK ──
  // If AI's text promises an action but no matching intent exists,
  // rewrite to an honest fallback. Better to admit confusion than ship a
  // lie. (See ACTION_VERBS / detectSilentLie above.)
  const lieReply = detectSilentLie(proposal, lang);
  if (lieReply) {
    return {
      kind: "talk",
      message: lieReply,
      _silentLieDetected: true, // diagnostic flag for harness
    };
  }

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
