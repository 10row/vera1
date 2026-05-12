"use strict";
// ─────────────────────────────────────────────────────────────────────
// STATUS-QUESTION SHORT-CIRCUIT
//
// The most-asked question on the bot ("what's available today", "how am
// I doing", "give me the picture") used to go through the AI, where it
// could hallucinate, quote balance instead of pace, or be unavailable
// when OpenAI was down. This test suite locks in the deterministic
// short-circuit: pipeline.isStatusQuestion catches the phrasing, the
// pipeline returns kind:"status", and view.statusSnapshot renders the
// daily-picture answer directly from state.
//
// Failsafe = NO AI involvement, NO hallucination risk, ZERO token cost,
// SAME shape every time. Adapts to paycheck vs contractor vs over-state.
// ─────────────────────────────────────────────────────────────────────
const m = require("../model");
const { applyIntent } = require("../engine");
const { statusSnapshot } = require("../view");
const { isStatusQuestion } = require("../pipeline");

function setupPaycheck(balance) {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 200000, payday: m.addDays(m.today("UTC"), 12), payFrequency: "monthly" },
  }).state;
  return s;
}
function setupIrregular(balance) {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 300000, payday: m.addDays(m.today("UTC"), 30), payFrequency: "irregular" },
  }).state;
  return s;
}

// ── isStatusQuestion: positive cases (EN) ──
const EN_HITS = [
  "how am i doing",
  "How am I doing?",
  "how'm i doing",
  "how am i looking",
  "where am i at",
  "where am i right now",
  "where do i stand",
  "what's the picture",
  "whats the picture",
  "what's my status",
  "what's available today",
  "what's available today?",
  "available today",
  "show me today",
  "show me my numbers",
  "show me the numbers",
  "my status",
  "my numbers",
  "today",
  "Today",
  "status",
  "how much can i spend today",
  "how much do i have today",
  "how am i",
  "check in",
  "give me the picture",
  "today's number",
  "today's situation",
];
for (const phrase of EN_HITS) {
  test('[status] EN regex matches: "' + phrase + '"', () => {
    assertEq(isStatusQuestion(phrase, "en"), true);
  });
}

// ── isStatusQuestion: positive cases (RU) ──
const RU_HITS = [
  "как я",
  "Как я?",
  "как дела",
  "где я",
  "где я сейчас",
  "что доступно сегодня",
  "что доступно сегодня?",
  "доступно сегодня",
  "моя картина",
  "мои числа",
  "мой статус",
  "статус",
  "сегодня",
  "Сегодня",
  "сколько я могу потратить сегодня",
  "сколько у меня сегодня",
  "покажи сегодня",
  "покажи мои числа",
];
for (const phrase of RU_HITS) {
  test('[status] RU regex matches: "' + phrase + '"', () => {
    assertEq(isStatusQuestion(phrase, "ru"), true);
  });
}

// ── isStatusQuestion: negative cases — MUST NOT match ──
// These should go to the AI / other paths, NOT short-circuit to status.
const NEGATIVES = [
  "spent 12 on coffee",                      // record_spend
  "i spent 30 yesterday",                    // backdated spend
  "got paid 2000",                           // record_income
  "can i afford 200",                        // ask_simulate
  "if i spend 60 on dinner",                 // ask_simulate
  "add rent 1200 on the 1st",                // add_bill
  "how much did i spend on coffee",          // historical talk
  "where do i spend most",                   // historical talk
  "delete the last one",                     // undo
  "undo",                                    // undo (but it's a command)
  "yes",                                     // confirm
  "no thanks",                               // dismiss
  "hi there how are you doing today friend", // > 80 chars typically
  "",                                        // empty
  "  ",                                      // whitespace
  "ab",                                      // too short
  "потратил 30 на кофе",                     // RU record_spend
  "могу ли я потратить 200",                 // RU ask_simulate
];
for (const phrase of NEGATIVES) {
  test('[status] regex does NOT match: "' + phrase + '"', () => {
    assertEq(isStatusQuestion(phrase, "en"), false);
    assertEq(isStatusQuestion(phrase, "ru"), false);
  });
}

// ── isStatusQuestion: cross-language fallback ──
// Even if state.language === "en", an RU phrase should still match
// (and vice versa) — defensive against mis-detected language.
test("[status] cross-language: RU phrase matches with en lang", () => {
  assertEq(isStatusQuestion("как я", "en"), true);
});
test("[status] cross-language: EN phrase matches with ru lang", () => {
  assertEq(isStatusQuestion("how am i doing", "ru"), true);
});

// ── statusSnapshot: pre-setup returns empty ──
test("[status] snapshot pre-setup returns empty string", () => {
  const s = m.createFreshState();
  const out = statusSnapshot(s, "en");
  assertEq(out, "");
});

// ── statusSnapshot: paycheck user — shows days-to-payday ──
test("[status] snapshot paycheck (calm) mentions 'to spend today' + 'to payday'", () => {
  const s = setupPaycheck(200000); // $2000, 12 days to payday
  const out = statusSnapshot(s, "en");
  assertTrue(/to spend today/.test(out), "should say 'to spend today'");
  assertTrue(/to payday/.test(out), "should mention 'to payday'");
  assertTrue(/\$/.test(out), "should show currency");
});

test("[status] snapshot paycheck RU uses Russian labels", () => {
  let s = setupPaycheck(200000);
  s.language = "ru";
  const out = statusSnapshot(s, "ru");
  assertTrue(/на сегодня/.test(out) || /перерасход сегодня/.test(out), "should say 'на сегодня'");
  assertTrue(/до зарплаты/.test(out), "should mention 'до зарплаты'");
});

// ── statusSnapshot: contractor — shows runway, NOT days-to-payday ──
test("[status] snapshot irregular shows runway, not 'to payday'", () => {
  const s = setupIrregular(300000);
  const out = statusSnapshot(s, "en");
  assertTrue(/runway/.test(out), "should say 'runway' for irregular pay");
  assertTrue(!/to payday/.test(out), "should NOT say 'to payday' for irregular pay");
});

test("[status] snapshot irregular RU uses 'хватит ещё'", () => {
  let s = setupIrregular(300000);
  s.language = "ru";
  const out = statusSnapshot(s, "ru");
  assertTrue(/хватит/.test(out), "should say 'хватит ещё на ~Nд'");
});

// ── statusSnapshot: over-state — deficit headline, not pace ──
test("[status] snapshot over-state leads with deficit, not pace", () => {
  let s = setupPaycheck(50000); // $500
  s = applyIntent(s, {
    kind: "add_bill",
    params: { name: "Rent", amountCents: 200000, dueDate: m.addDays(m.today("UTC"), 5), recurrence: "monthly" },
  }).state;
  const out = statusSnapshot(s, "en");
  assertTrue(/over for this cycle/.test(out), "should say 'over for this cycle'");
  assertTrue(/balance/.test(out), "should reference balance for context");
});

// ── statusSnapshot: structure is THREE lines (or 2 in over-state) ──
test("[status] snapshot has multi-line structure", () => {
  const s = setupPaycheck(200000);
  const out = statusSnapshot(s, "en");
  const lines = out.split("\n").filter(Boolean);
  assertTrue(lines.length >= 2, "should be at least 2 lines (headline + context)");
});

// ── BRAND INVARIANT: never lead with raw balance ──
// The whole point of the brand is "ONE number a day". Status snapshot
// must lead with daily pace / today's-left, NOT balance. Balance is
// reference only.
test("[status] snapshot leads with today's-left, NOT bank balance", () => {
  const s = setupPaycheck(200000);
  const out = statusSnapshot(s, "en");
  const firstLine = out.split("\n")[0];
  // First line must mention "today" — the daily picture, not balance.
  assertTrue(/today/i.test(firstLine), "first line must reference 'today' (the daily number)");
  // First line must NOT be a balance dump.
  assertTrue(!/in account/.test(firstLine), "first line must NOT be 'X in account'");
});

// ── FAILSAFE: same input → same output (no randomness) ──
test("[status] snapshot is deterministic (same state → same output)", () => {
  const s = setupPaycheck(200000);
  const a = statusSnapshot(s, "en");
  const b = statusSnapshot(s, "en");
  assertEq(a, b);
});
