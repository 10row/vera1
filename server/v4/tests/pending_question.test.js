"use strict";
// Pending-question stickiness — the bot remembers what it asked and the
// AI re-asks gently if the user didn't answer. Auto-expires after 3 turns
// so we never badger forever.

const m = require("../model");
const { parseProposal, buildSystemPrompt } = require("../ai");
const { processMessage } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

// ── MODEL: updatePendingQuestion helper ─────────────────────────

test("[PQ] updatePendingQuestion: null/undefined input clears", () => {
  const s = m.createFreshState();
  s.pendingQuestion = { text: "x?", kind: "balance", askedAt: 1, turnsAlive: 1 };
  m.updatePendingQuestion(s, null);
  assertEq(s.pendingQuestion, null);
});

test("[PQ] updatePendingQuestion: empty text clears", () => {
  const s = m.createFreshState();
  s.pendingQuestion = { text: "x?", kind: "balance", askedAt: 1, turnsAlive: 1 };
  m.updatePendingQuestion(s, { text: "", kind: "balance" });
  assertEq(s.pendingQuestion, null);
});

test("[PQ] updatePendingQuestion: fresh question starts at turnsAlive=1", () => {
  const s = m.createFreshState();
  m.updatePendingQuestion(s, { text: "What's your balance?", kind: "balance" });
  assertEq(s.pendingQuestion.text, "What's your balance?");
  assertEq(s.pendingQuestion.kind, "balance");
  assertEq(s.pendingQuestion.turnsAlive, 1);
  assertTrue(typeof s.pendingQuestion.askedAt === "number");
});

test("[PQ] updatePendingQuestion: same text+kind increments turnsAlive", () => {
  const s = m.createFreshState();
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  assertEq(s.pendingQuestion.turnsAlive, 1);
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  assertEq(s.pendingQuestion.turnsAlive, 2);
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  assertEq(s.pendingQuestion.turnsAlive, 3);
});

test("[PQ] updatePendingQuestion: auto-clears after 3 turns (don't badger)", () => {
  const s = m.createFreshState();
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  // 4th attempt → cleared
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  assertEq(s.pendingQuestion, null);
});

test("[PQ] updatePendingQuestion: different text resets turnsAlive to 1", () => {
  const s = m.createFreshState();
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  m.updatePendingQuestion(s, { text: "balance?", kind: "balance" });
  assertEq(s.pendingQuestion.turnsAlive, 2);
  m.updatePendingQuestion(s, { text: "When's payday?", kind: "payday" });
  assertEq(s.pendingQuestion.turnsAlive, 1);
  assertEq(s.pendingQuestion.kind, "payday");
});

test("[PQ] updatePendingQuestion: invalid kind defaults to general", () => {
  const s = m.createFreshState();
  m.updatePendingQuestion(s, { text: "huh?", kind: "transfer_to_attacker" });
  assertEq(s.pendingQuestion.kind, "general");
});

test("[PQ] updatePendingQuestion: text trimmed and clamped to 240 chars", () => {
  const s = m.createFreshState();
  const long = "  " + "a".repeat(500) + "  ";
  m.updatePendingQuestion(s, { text: long, kind: "general" });
  assertEq(s.pendingQuestion.text.length, 240);
  assertEq(s.pendingQuestion.text[0], "a"); // trimmed leading whitespace
});

// ── AI: parseProposal extracts pendingQuestion ──────────────────

test("[PQ] parseProposal extracts pendingQuestion from AI output", async () => {
  const s = m.createFreshState();
  const proposal = await parseProposal(s, "hi", [], {
    _aiCall: stub({
      mode: "talk",
      message: "Hey! What's your balance?",
      intents: [],
      pendingQuestion: { text: "What's your rough balance?", kind: "balance" },
    }),
  });
  assertEq(proposal.mode, "talk");
  assertEq(proposal.pendingQuestion.text, "What's your rough balance?");
  assertEq(proposal.pendingQuestion.kind, "balance");
});

test("[PQ] parseProposal returns null pendingQuestion when AI omits it", async () => {
  const s = m.createFreshState();
  const proposal = await parseProposal(s, "hi", [], {
    _aiCall: stub({ mode: "talk", message: "Hi!", intents: [] }),
  });
  assertEq(proposal.pendingQuestion, null);
});

test("[PQ] parseProposal returns null on AI failure", async () => {
  const s = m.createFreshState();
  const proposal = await parseProposal(s, "hi", [], {
    _aiCall: async () => { throw new Error("network"); },
  });
  assertEq(proposal.pendingQuestion, null);
});

test("[PQ] parseProposal sanitizes garbage pendingQuestion", async () => {
  const s = m.createFreshState();
  const proposal = await parseProposal(s, "hi", [], {
    _aiCall: stub({
      mode: "talk",
      message: "Hey",
      intents: [],
      pendingQuestion: { text: "", kind: "balance" },
    }),
  });
  assertEq(proposal.pendingQuestion, null);
});

// ── AI prompt: includes pendingQuestion when state has one ──────

test("[PQ] buildSystemPrompt includes pendingQuestion when set", () => {
  const s = m.createFreshState();
  s.pendingQuestion = {
    text: "What's your rough balance?",
    kind: "balance",
    askedAt: Date.now(),
    turnsAlive: 1,
  };
  const prompt = buildSystemPrompt(s);
  assertTrue(/PENDING QUESTION/.test(prompt), "prompt mentions PENDING QUESTION");
  assertTrue(/What's your rough balance\?/.test(prompt), "prompt includes the question text");
});

test("[PQ] buildSystemPrompt omits pendingQuestion section when state has none", () => {
  const s = m.createFreshState();
  const prompt = buildSystemPrompt(s);
  assertTrue(!/PENDING QUESTION/.test(prompt), "no PENDING QUESTION section when state has none");
});

// ── PIPELINE: pendingQuestion passes through every result shape ─

test("[PQ] pipeline: talk result carries pendingQuestion", async () => {
  const s = m.createFreshState();
  const r = await processMessage(s, "hi", [], {
    _aiCall: stub({
      mode: "talk",
      message: "Hey!",
      intents: [],
      pendingQuestion: { text: "balance?", kind: "balance" },
    }),
  });
  assertEq(r.kind, "talk");
  assertEq(r.pendingQuestion.text, "balance?");
});

test("[PQ] pipeline: do result carries pendingQuestion", async () => {
  const s = m.createFreshState();
  const r = await processMessage(s, "I have 5000", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting up.",
      intents: [{ kind: "setup_account", params: { balanceCents: 5_000_00 } }],
      pendingQuestion: { text: "When's payday?", kind: "payday" },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.pendingQuestion.text, "When's payday?");
});

test("[PQ] pipeline: decision result carries pendingQuestion", async () => {
  const { applyIntent } = require("../engine");
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: 5_000_00, payday: m.addDays(m.today("UTC"), 30), payFrequency: "monthly" },
  }).state;
  const r = await processMessage(s, "can I afford 200?", [], {
    _aiCall: stub({
      mode: "do",
      message: "Looking at it.",
      intents: [{ kind: "simulate_spend", params: { amountCents: 200_00 } }],
      pendingQuestion: { text: "Want me to log it?", kind: "yes_no" },
    }),
  });
  assertEq(r.kind, "decision");
  assertEq(r.pendingQuestion.text, "Want me to log it?");
});

// ── INTEGRATION: full sticky flow simulated through the model ───

test("[PQ] sticky flow: bot asks → user dodges → bot re-asks → user answers → cleared", async () => {
  // Turn 1: empty state, AI asks for balance.
  const s = m.createFreshState();
  const r1 = await processMessage(s, "hi", [], {
    _aiCall: stub({
      mode: "talk",
      message: "Hey! What's your rough balance?",
      intents: [],
      pendingQuestion: { text: "What's your rough balance?", kind: "balance" },
    }),
  });
  m.updatePendingQuestion(s, r1.pendingQuestion);
  assertEq(s.pendingQuestion.text, "What's your rough balance?");
  assertEq(s.pendingQuestion.turnsAlive, 1);

  // Turn 2: user dodges. AI re-asks.
  const r2 = await processMessage(s, "what's the weather", [], {
    _aiCall: stub({
      mode: "talk",
      message: "Haha — anyway, what's your rough balance?",
      intents: [],
      pendingQuestion: { text: "What's your rough balance?", kind: "balance" },
    }),
  });
  m.updatePendingQuestion(s, r2.pendingQuestion);
  assertEq(s.pendingQuestion.turnsAlive, 2);

  // Turn 3: user answers. AI omits pendingQuestion.
  const r3 = await processMessage(s, "5000", [], {
    _aiCall: stub({
      mode: "do",
      message: "Got it. When's payday?",
      intents: [{ kind: "setup_account", params: { balanceCents: 5_000_00 } }],
    }),
  });
  m.updatePendingQuestion(s, r3.pendingQuestion);
  assertEq(s.pendingQuestion, null);
});

test("[PQ] sticky flow: 4th re-ask auto-clears (don't badger)", async () => {
  const s = m.createFreshState();
  const aiResp = {
    mode: "talk",
    message: "Anyway, balance?",
    intents: [],
    pendingQuestion: { text: "What's your balance?", kind: "balance" },
  };
  for (let i = 0; i < 3; i++) {
    const r = await processMessage(s, "ignore", [], { _aiCall: stub(aiResp) });
    m.updatePendingQuestion(s, r.pendingQuestion);
  }
  assertEq(s.pendingQuestion.turnsAlive, 3);
  // 4th turn: AI tries to re-ask again → state auto-clears
  const r = await processMessage(s, "ignore again", [], { _aiCall: stub(aiResp) });
  m.updatePendingQuestion(s, r.pendingQuestion);
  assertEq(s.pendingQuestion, null);
});
