"use strict";
// Pipeline + integration tests. The killer scenario: AI emits setup_account
// on an already-setup user. Onboarding handles it deterministically. The AI
// is never asked about setup. Cannot loop.

const m = require("../model");
const { applyIntent } = require("../engine");
const { processMessage } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function fullySetUp(balance) {
  let s = m.createFreshState();
  return applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: "2025-05-15", payFrequency: "monthly" },
  }).state;
}

// ── ONBOARDING ROUTE: AI is bypassed ──────────────
test("[pipeline] virgin state + 'hi' → onboarding kind, no AI call", async () => {
  let aiCalled = false;
  const r = await processMessage(m.createFreshState(), "hi", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(r.kind, "onboarding");
  assertEq(aiCalled, false);
});
test("[pipeline] virgin state + '5000' → onboarding draft, no AI call", async () => {
  let aiCalled = false;
  const r = await processMessage(m.createFreshState(), "5000", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(r.kind, "onboarding");
  assertEq(aiCalled, false);
  assertEq(r.draft.balanceCents, 500000);
});
test("[pipeline] virgin + '5000 paid the 15th' → onboarding intent, no AI call", async () => {
  let aiCalled = false;
  const r = await processMessage(m.createFreshState(), "5000 paid the 15th", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(r.kind, "onboarding");
  assertEq(aiCalled, false);
  assertEq(r.intent.kind, "setup_account");
});

// ── POST-SETUP: AI extracts intent ────────────────
test("[pipeline] post-setup spend → do mode with confirm verdict", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "spent 20 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging that.",
      intent: { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(r.verdict.ok, true);
});
test("[pipeline] post-setup income → do mode", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "got 3000 paycheck", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding that.",
      intent: { kind: "record_income", params: { amountCents: 300000, note: "paycheck" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_income");
});
test("[pipeline] post-setup add bill → do mode", async () => {
  const s = fullySetUp();
  const futureDate = m.addDays(m.today("UTC"), 14);
  const r = await processMessage(s, "rent 1400 due the 1st", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding rent.",
      intent: { kind: "add_bill", params: { name: "Rent", amountCents: 140000, dueDate: futureDate, recurrence: "monthly" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "add_bill");
  assertEq(r.verdict.ok, true);
});

// ── KILLER: AI emits setup_account on already-setup ─────
test("[pipeline] post-setup: AI emits setup_account → validator REJECTS (defense in depth)", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "fancy something", [], {
    _aiCall: stub({
      mode: "do",
      message: "Setting up.",
      intent: { kind: "setup_account", params: { balanceCents: 999999 } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, false);
  assertTrue(/already set up/i.test(r.verdict.reason));
});

// ── DECISION SUPPORT ──────────────────────────────
test("[pipeline] post-setup 'can I afford 200?' → decision kind with sim", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "can I afford 200?", [], {
    _aiCall: stub({
      mode: "ask_simulate",
      message: "Looking at it.",
      amountCents: 20000,
    }),
  });
  assertEq(r.kind, "decision");
  assertTrue(!!r.simulate);
  assertEq(r.simulate.projected.balanceCents, s.balanceCents - 20000);
});

// ── UNKNOWN INTENT FROM AI ────────────────────────
test("[pipeline] AI emits unknown intent kind → validator REJECTS", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "do weird stuff", [], {
    _aiCall: stub({
      mode: "do",
      message: "ok",
      intent: { kind: "transfer_to_attacker", params: {} },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.verdict.ok, false);
});

// ── TALK FALLBACK ─────────────────────────────────
test("[pipeline] AI returns talk → talk kind", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "how are you", [], {
    _aiCall: stub({ mode: "talk", message: "Doing alright. What's up?" }),
  });
  assertEq(r.kind, "talk");
});
test("[pipeline] AI returns garbage JSON → talk fallback, no crash", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "hi", [], { _aiCall: async () => "not json at all" });
  assertEq(r.kind, "talk");
});
test("[pipeline] AI throws → talk fallback with apology", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "hi", [], { _aiCall: async () => { throw new Error("network"); } });
  assertEq(r.kind, "talk");
});

// ── THE LOOP TEST: virgin + 'ok' should never crash or loop ─
test("[pipeline] virgin + 10 random inputs → never produces a setup_account intent without a balance (excluding skip words)", async () => {
  let s = m.createFreshState();
  // Inputs MUST not contain numbers (else parseAmount picks them up) and
  // MUST not be skip words (else early-skip exits onboarding intentionally).
  const inputs = ["hi", "ok", "lol", "what", "huh", "yes", "?", "🚀", "hmm", "ehh"];
  for (const inp of inputs) {
    const r = await processMessage(s, inp, [], { _aiCall: async () => { throw new Error("AI shouldn't be called"); } });
    assertEq(r.kind, "onboarding");
    assertEq(r.intent, null);
  }
  assertEq(s.setup, false);
});
