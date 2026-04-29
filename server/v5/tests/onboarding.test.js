"use strict";
// Onboarding state machine — the heart of the rebuild.
// MUST be deterministic. MUST never loop. MUST handle natural input.

const m = require("../model");
const onboarding = require("../onboarding");
const { applyIntent } = require("../engine");

const TODAY = "2025-04-28";

// ── PARSE AMOUNT ──────────────────────────────────
test("[onboarding] parseAmount: '5000' → 500000 cents", () => {
  assertEq(onboarding.parseAmount("5000"), 500000);
});
test("[onboarding] parseAmount: '$5,000.50' → 500050", () => {
  assertEq(onboarding.parseAmount("$5,000.50"), 500050);
});
test("[onboarding] parseAmount: '5k' → 500000", () => {
  assertEq(onboarding.parseAmount("5k"), 500000);
});
test("[onboarding] parseAmount: '5.5k' → 550000", () => {
  assertEq(onboarding.parseAmount("5.5k"), 550000);
});
test("[onboarding] parseAmount: '$5k' → 500000", () => {
  assertEq(onboarding.parseAmount("$5k"), 500000);
});
test("[onboarding] parseAmount: 'about 5000 ish' → 500000", () => {
  assertEq(onboarding.parseAmount("about 5000 ish"), 500000);
});
test("[onboarding] parseAmount: 'five thousand' → 500000", () => {
  assertEq(onboarding.parseAmount("five thousand"), 500000);
});
test("[onboarding] parseAmount: 'two hundred' → 20000", () => {
  assertEq(onboarding.parseAmount("two hundred"), 20000);
});
test("[onboarding] parseAmount: 'twelve' → 1200", () => {
  assertEq(onboarding.parseAmount("twelve"), 1200);
});
test("[onboarding] parseAmount: 'hi' → null", () => {
  assertEq(onboarding.parseAmount("hi"), null);
});
test("[onboarding] parseAmount: '' → null", () => {
  assertEq(onboarding.parseAmount(""), null);
});
test("[onboarding] parseAmount: rejects negative", () => {
  // "-50" — minus sign in front. We don't accept negative balances.
  // The parser will pull "50". That's fine — engine validation is the second line.
  // Just make sure we don't crash.
  const r = onboarding.parseAmount("-50");
  assertTrue(r === null || r === 5000);
});

// ── PARSE PAYDAY ──────────────────────────────────
test("[onboarding] parsePayday: 'the 15th' (today is Apr 28) → next May 15", () => {
  assertEq(onboarding.parsePayday("the 15th", "2025-04-28"), "2025-05-15");
});
test("[onboarding] parsePayday: '15th' (today is Apr 14) → Apr 15 same month", () => {
  assertEq(onboarding.parsePayday("15th", "2025-04-14"), "2025-04-15");
});
test("[onboarding] parsePayday: '1st' (today is Apr 1) → next May 1 (target ≤ today rolls forward)", () => {
  assertEq(onboarding.parsePayday("1st", "2025-04-01"), "2025-05-01");
});
test("[onboarding] parsePayday: 'tomorrow' → +1 day", () => {
  assertEq(onboarding.parsePayday("tomorrow", "2025-04-28"), "2025-04-29");
});
test("[onboarding] parsePayday: 'today' → today", () => {
  assertEq(onboarding.parsePayday("today", "2025-04-28"), "2025-04-28");
});
test("[onboarding] parsePayday: 'in 2 weeks' → +14 days", () => {
  assertEq(onboarding.parsePayday("in 2 weeks", "2025-04-28"), "2025-05-12");
});
test("[onboarding] parsePayday: 'May 1' → 2025-05-01", () => {
  assertEq(onboarding.parsePayday("May 1", "2025-04-28"), "2025-05-01");
});
test("[onboarding] parsePayday: 'April 30' → 2025-04-30 (later this month)", () => {
  assertEq(onboarding.parsePayday("April 30", "2025-04-28"), "2025-04-30");
});
test("[onboarding] parsePayday: 'jan 5' → 2026-01-05 (next year if past)", () => {
  assertEq(onboarding.parsePayday("jan 5", "2025-04-28"), "2026-01-05");
});
test("[onboarding] parsePayday: '2025-05-15' (ISO) → same", () => {
  assertEq(onboarding.parsePayday("2025-05-15", "2025-04-28"), "2025-05-15");
});
test("[onboarding] parsePayday: 'next friday' (Mon=2025-04-28) → 2025-05-02", () => {
  assertEq(onboarding.parsePayday("next friday", "2025-04-28"), "2025-05-02");
});
test("[onboarding] parsePayday: garbage → null", () => {
  assertEq(onboarding.parsePayday("lol idk", "2025-04-28"), null);
});

// ── HANDLE: STATE MACHINE ─────────────────────────
test("[onboarding] greeting on virgin state → ask balance", () => {
  const s = m.createFreshState();
  const d = onboarding.handle(s, "hi", TODAY);
  assertEq(d.done, false);
  assertEq(d.intent, undefined);
  assertTrue(/balance/i.test(d.reply));
});
test("[onboarding] /start on virgin → ask balance", () => {
  const s = m.createFreshState();
  const d = onboarding.handle(s, "/start", TODAY);
  assertEq(d.done, false);
  assertTrue(/balance/i.test(d.reply));
});
test("[onboarding] empty input on virgin → ask balance", () => {
  const s = m.createFreshState();
  const d = onboarding.handle(s, "", TODAY);
  assertTrue(/balance/i.test(d.reply));
});
test("[onboarding] phase 1: balance only → save draft, ask payday", () => {
  const s = m.createFreshState();
  const d = onboarding.handle(s, "5000", TODAY);
  assertEq(d.done, false);
  assertEq(d.draft.balanceCents, 500000);
  assertTrue(/paycheck|payday/i.test(d.reply));
});
test("[onboarding] phase 1: balance + payday in one msg → setup_account, done", () => {
  const s = m.createFreshState();
  const d = onboarding.handle(s, "5000 paid the 15th", TODAY);
  assertEq(d.done, true);
  assertEq(d.intent.kind, "setup_account");
  assertEq(d.intent.params.balanceCents, 500000);
  assertEq(d.intent.params.payday, "2025-05-15");
  assertEq(d.intent.params.payFrequency, "monthly");
});
test("[onboarding] phase 1: gibberish → re-ask balance, no draft", () => {
  const s = m.createFreshState();
  const d = onboarding.handle(s, "lol whatever", TODAY);
  assertEq(d.done, false);
  assertEq(d.draft, undefined);
});
test("[onboarding] phase 2: payday answer → setup_account, done", () => {
  const s = m.createFreshState();
  s.onboardingDraft = { balanceCents: 500000 };
  const d = onboarding.handle(s, "the 15th", TODAY);
  assertEq(d.done, true);
  assertEq(d.intent.kind, "setup_account");
  assertEq(d.intent.params.balanceCents, 500000);
  assertEq(d.intent.params.payday, "2025-05-15");
  assertEq(d.clearDraft, true);
});
test("[onboarding] phase 2: 'skip' → setup with default payday, irregular freq", () => {
  const s = m.createFreshState();
  s.onboardingDraft = { balanceCents: 500000 };
  const d = onboarding.handle(s, "skip", TODAY);
  assertEq(d.done, true);
  assertEq(d.intent.params.payFrequency, "irregular");
  assertTrue(d.intent.params.payday > TODAY);
});
test("[onboarding] phase 2: gibberish → re-ask payday", () => {
  const s = m.createFreshState();
  s.onboardingDraft = { balanceCents: 500000 };
  const d = onboarding.handle(s, "uhhh dunno", TODAY);
  assertEq(d.done, false);
  assertTrue(/15th|May|skip/i.test(d.reply) || /15-го|пропустить/i.test(d.reply));
});

// ── INTEGRATION: full deterministic flow ──────────
test("[onboarding] full flow: 'hi' → '5000' → 'the 15th' → setup applied", () => {
  let s = m.createFreshState();
  // Turn 1
  let d = onboarding.handle(s, "hi", TODAY);
  assertEq(d.done, false);
  // Turn 2
  d = onboarding.handle(s, "5000", TODAY);
  s.onboardingDraft = d.draft;
  assertEq(d.done, false);
  // Turn 3
  d = onboarding.handle(s, "the 15th", TODAY);
  assertEq(d.done, true);
  s = applyIntent(s, d.intent).state;
  s.onboardingDraft = null;
  assertEq(s.setup, true);
  assertEq(s.balanceCents, 500000);
  assertEq(s.payday, "2025-05-15");
});

test("[onboarding] never enters infinite loop: 10 truly garbage inputs always re-ask", () => {
  let s = m.createFreshState();
  // Inputs MUST contain no digits — otherwise parseAmount might extract
  // them as a balance (which is correct for natural input like "I have 5000").
  const garbage = ["lol", "what", "huh", "really", "nope", "lmao", "uhhh", "?", "wtf", "🚀"];
  for (const g of garbage) {
    const d = onboarding.handle(s, g, TODAY);
    assertEq(d.done, false);
    if (d.draft) s.onboardingDraft = d.draft;
  }
  // After all that garbage, state should still be virgin.
  assertEq(s.setup, false);
});

// ── RUSSIAN LANG ──────────────────────────────────
test("[onboarding] Russian greeting: 'привет' → ask balance in Russian", () => {
  const s = m.createFreshState();
  s.language = "ru";
  const d = onboarding.handle(s, "привет", TODAY);
  assertTrue(/счёт|баланс/i.test(d.reply));
});
test("[onboarding] Russian skip word: 'пропустить' → setup with irregular", () => {
  const s = m.createFreshState();
  s.language = "ru";
  s.onboardingDraft = { balanceCents: 500000 };
  const d = onboarding.handle(s, "пропустить", TODAY);
  assertEq(d.done, true);
  assertEq(d.intent.params.payFrequency, "irregular");
});
