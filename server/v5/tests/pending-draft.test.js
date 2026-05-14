"use strict";
// ─────────────────────────────────────────────────────────────────────
// PENDING DRAFT — clarify-state across turns
//
// THE bug this fixes: user said "dry cleaning 3150 thb tomorrow", AI
// dropped the date, validator clarified "when?", user said "tomorrow",
// bot asked "when?" AGAIN because there was no clarify state machine.
// Every clarify path had this dead-end.
//
// FIX: when the validator emits a clarify, pipeline persists a
// pendingDraft on state. The NEXT user message goes through a
// deterministic resolver for the missing field BEFORE the AI is called.
// On hit, merge + validate + emit. No AI round-trip.
// ─────────────────────────────────────────────────────────────────────
const m = require("../model");
const { applyIntent } = require("../engine");
const { processMessage, resolveForwardDateFromText, resolvePendingField, tryResolvePending, makePendingDraft } = require("../pipeline");

const stub = (resp) => async () => typeof resp === "string" ? resp : JSON.stringify(resp);

function fullySetUp(balance) {
  let s = m.createFreshState();
  s = applyIntent(s, {
    kind: "setup_account",
    params: { balanceCents: balance || 500000, payday: m.addDays(m.today("UTC"), 20), payFrequency: "monthly" },
  }).state;
  return s;
}

// ── resolveForwardDateFromText ──
test("[forward-date] 'tomorrow' → today + 1", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("tomorrow", today);
  assertEq(r && r.date, "2026-05-15");
});
test("[forward-date] 'day after tomorrow' → today + 2", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("day after tomorrow", today);
  assertEq(r && r.date, "2026-05-16");
});
test("[forward-date] 'in 3 days' → today + 3", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("in 3 days", today);
  assertEq(r && r.date, "2026-05-17");
});
test("[forward-date] 'in 2 weeks' → today + 14", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("in 2 weeks", today);
  assertEq(r && r.date, "2026-05-28");
});
test("[forward-date] 'next week' → today + 7", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("next week", today);
  assertEq(r && r.date, "2026-05-21");
});
test("[forward-date] 'next friday' → next-occurrence friday", () => {
  // 2026-05-14 is a Thursday (day 4). Next Friday = +1.
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("next friday", today);
  assertEq(r && r.date, "2026-05-15");
});
test("[forward-date] 'the 15th' → next 15th from today", () => {
  // today is 14th, 15th is 1 day away.
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("the 15th", today);
  assertEq(r && r.date, "2026-05-15");
});
test("[forward-date] 'the 1st' when today is 14th → next month's 1st", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("the 1st", today);
  assertEq(r && r.date, "2026-06-01");
});
test("[forward-date] ISO future date passes through", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("2026-12-25", today);
  assertEq(r && r.date, "2026-12-25");
});
test("[forward-date] past phrase → null", () => {
  const today = "2026-05-14";
  assertEq(resolveForwardDateFromText("yesterday", today), null);
  assertEq(resolveForwardDateFromText("3 days ago", today), null);
});
test("[forward-date] Russian 'завтра' → today + 1", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("завтра", today);
  assertEq(r && r.date, "2026-05-15");
});
test("[forward-date] Russian 'через 3 дня' → today + 3", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("через 3 дня", today);
  assertEq(r && r.date, "2026-05-17");
});
test("[forward-date] Russian 'через неделю' → today + 7", () => {
  const today = "2026-05-14";
  const r = resolveForwardDateFromText("через неделю", today);
  assertEq(r && r.date, "2026-05-21");
});
test("[forward-date] unrelated text → null", () => {
  assertEq(resolveForwardDateFromText("hello world", "2026-05-14"), null);
  assertEq(resolveForwardDateFromText("spent 25 on coffee", "2026-05-14"), null);
});

// ── resolvePendingField (amountCents) ──
test("[resolve-amount] '3150' → 315000 cents", () => {
  const state = { currency: "USD" };
  assertEq(resolvePendingField("amountCents", "3150", state), 315000);
});
test("[resolve-amount] '$50' → 5000 cents", () => {
  const state = { currency: "USD" };
  const r = resolvePendingField("amountCents", "$50", state);
  // Either the currency parser handles it (returns subunits) or the fallback (returns 5000).
  assertTrue(r === 5000, "got " + r);
});
test("[resolve-amount] 'lol' → null", () => {
  const state = { currency: "USD" };
  assertEq(resolvePendingField("amountCents", "lol", state), null);
});

// ── resolvePendingField (recurrence) ──
test("[resolve-recurrence] 'once' → 'once'", () => {
  assertEq(resolvePendingField("recurrence", "once", {}), "once");
});
test("[resolve-recurrence] 'monthly' → 'monthly'", () => {
  assertEq(resolvePendingField("recurrence", "monthly", {}), "monthly");
});
test("[resolve-recurrence] 'every month' → 'monthly'", () => {
  assertEq(resolvePendingField("recurrence", "every month", {}), "monthly");
});
test("[resolve-recurrence] 'ежемесячно' → 'monthly'", () => {
  assertEq(resolvePendingField("recurrence", "ежемесячно", {}), "monthly");
});
test("[resolve-recurrence] 'lol' → null", () => {
  assertEq(resolvePendingField("recurrence", "lol", {}), null);
});

// ── resolvePendingField (name) ──
test("[resolve-name] 'dry cleaning' → 'dry cleaning'", () => {
  assertEq(resolvePendingField("name", "dry cleaning", {}), "dry cleaning");
});
test("[resolve-name] 'yes' → null", () => {
  assertEq(resolvePendingField("name", "yes", {}), null);
});
test("[resolve-name] '3150' (pure number) → null", () => {
  assertEq(resolvePendingField("name", "3150", {}), null);
});
test("[resolve-name] empty → null", () => {
  assertEq(resolvePendingField("name", "", {}), null);
});

// ── tryResolvePending dispatcher ──
test("[try-resolve] no pendingDraft → null", () => {
  assertEq(tryResolvePending({ pendingDraft: null }, "tomorrow", Date.now()), null);
});
test("[try-resolve] pending dueDate + 'tomorrow' → resolved", () => {
  const s = {
    timezone: "UTC",
    pendingDraft: {
      intent: { kind: "add_bill", params: { name: "Dry cleaning", amountCents: 315000, recurrence: "once" } },
      missingField: "dueDate",
      ts: Date.now(),
      expiresAt: Date.now() + 60000,
      turnCount: 0,
    },
  };
  const r = tryResolvePending(s, "tomorrow", Date.now());
  assertTrue(r && r.resolved, "should resolve");
  assertEq(r.resolved.intent.kind, "add_bill");
  assertTrue(typeof r.resolved.intent.params.dueDate === "string", "dueDate must be ISO string");
});
test("[try-resolve] pending expired → expired", () => {
  const s = {
    pendingDraft: {
      intent: { kind: "add_bill", params: {} },
      missingField: "dueDate",
      ts: Date.now() - 999999,
      expiresAt: Date.now() - 1,
      turnCount: 0,
    },
  };
  const r = tryResolvePending(s, "tomorrow", Date.now());
  assertEq(r && r.expired, true);
});
test("[try-resolve] turnCount >= max → expired", () => {
  const s = {
    pendingDraft: {
      intent: { kind: "add_bill", params: {} },
      missingField: "dueDate",
      ts: Date.now(),
      expiresAt: Date.now() + 60000,
      turnCount: 3,
    },
  };
  const r = tryResolvePending(s, "tomorrow", Date.now());
  assertEq(r && r.expired, true);
});
test("[try-resolve] pending alive + unrelated msg → miss", () => {
  const s = {
    timezone: "UTC",
    pendingDraft: {
      intent: { kind: "add_bill", params: {} },
      missingField: "dueDate",
      ts: Date.now(),
      expiresAt: Date.now() + 60000,
      turnCount: 0,
    },
  };
  const r = tryResolvePending(s, "hello there", Date.now());
  assertEq(r && r.miss, true);
});

// ── THE DRY-CLEANING-LOOP SCENARIO: end-to-end through processMessage ──
test("[pipeline] turn 1: AI emits add_bill without dueDate → clarify + pendingDraft set", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "dry cleaning 3150 thb", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding dry cleaning.",
      // AI emits add_bill but omits dueDate.
      intent: {
        kind: "add_bill",
        params: { name: "Dry cleaning", amountCents: 315000, recurrence: "once" },
      },
    }),
  });
  assertEq(r.kind, "clarify");
  assertEq(r.field, "dueDate");
  assertTrue(!!s.pendingDraft, "pendingDraft must be set on state");
  assertEq(s.pendingDraft.intent.kind, "add_bill");
  assertEq(s.pendingDraft.missingField, "dueDate");
});

test("[pipeline] turn 2 after clarify: user says 'tomorrow' → resolved without AI", async () => {
  let s = fullySetUp();
  // Manually set pendingDraft as if turn 1 already happened.
  s.pendingDraft = {
    intent: { kind: "add_bill", params: { name: "Dry cleaning", amountCents: 315000, recurrence: "once" } },
    missingField: "dueDate",
    ts: Date.now(),
    expiresAt: Date.now() + 60000,
    turnCount: 0,
  };
  let aiCalled = false;
  const r = await processMessage(s, "tomorrow", [], {
    _aiCall: async () => { aiCalled = true; return ""; },
  });
  assertEq(aiCalled, false, "AI must NOT be called — pendingDraft resolved deterministically");
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "add_bill");
  assertTrue(!!r.intent.params.dueDate, "dueDate must be set");
  assertEq(s.pendingDraft, null, "pendingDraft must be cleared after resolution");
});

test("[pipeline] turn 2 with 'tomorrow' resolves to today + 1 ISO date", async () => {
  let s = fullySetUp();
  s.pendingDraft = {
    intent: { kind: "add_bill", params: { name: "Phone bill", amountCents: 5000, recurrence: "once" } },
    missingField: "dueDate",
    ts: Date.now(),
    expiresAt: Date.now() + 60000,
    turnCount: 0,
  };
  const r = await processMessage(s, "tomorrow", [], {
    _aiCall: async () => "",
  });
  const todayStr = m.today(s.timezone || "UTC");
  const expectedTomorrow = m.addDays(todayStr, 1);
  assertEq(r.kind, "do");
  assertEq(r.intent.params.dueDate, expectedTomorrow);
});

test("[pipeline] turn 2 with 'через 3 дня' (RU) resolves", async () => {
  let s = fullySetUp();
  s.language = "ru";
  s.pendingDraft = {
    intent: { kind: "add_bill", params: { name: "Аренда", amountCents: 5000, recurrence: "once" } },
    missingField: "dueDate",
    ts: Date.now(),
    expiresAt: Date.now() + 60000,
    turnCount: 0,
  };
  const r = await processMessage(s, "через 3 дня", [], {
    _aiCall: async () => "",
  });
  const todayStr = m.today(s.timezone || "UTC");
  assertEq(r.kind, "do");
  assertEq(r.intent.params.dueDate, m.addDays(todayStr, 3));
});

test("[pipeline] pendingDraft cleared after successful AI-driven do (unrelated next message)", async () => {
  let s = fullySetUp();
  s.pendingDraft = {
    intent: { kind: "add_bill", params: { name: "Dry cleaning", amountCents: 315000, recurrence: "once" } },
    missingField: "dueDate",
    ts: Date.now(),
    expiresAt: Date.now() + 60000,
    turnCount: 0,
  };
  // User abandons the clarify and logs a spend instead.
  const r = await processMessage(s, "spent 20 on coffee", [], {
    _aiCall: stub({
      mode: "do",
      message: "Logging coffee.",
      intent: { kind: "record_spend", params: { amountCents: 2000, note: "coffee" } },
    }),
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "record_spend");
  assertEq(s.pendingDraft, null, "pendingDraft must be cleared when user does something else");
});

test("[pipeline] pendingDraft turnCount increments on miss", async () => {
  let s = fullySetUp();
  s.pendingDraft = {
    intent: { kind: "add_bill", params: { name: "Dry cleaning", amountCents: 315000, recurrence: "once" } },
    missingField: "dueDate",
    ts: Date.now(),
    expiresAt: Date.now() + 60000,
    turnCount: 0,
  };
  // Unrelated reply — doesn't resolve to a date AND AI returns talk.
  await processMessage(s, "hmm", [], {
    _aiCall: stub({ mode: "talk", message: "Ok." }),
  });
  assertEq(s.pendingDraft && s.pendingDraft.turnCount, 1);
});

// ── SECONDARY: pendingDraft from add_income clarify ──
test("[pipeline] clarify on add_income expectedDate → pendingDraft set with field='expectedDate'", async () => {
  const s = fullySetUp();
  const r = await processMessage(s, "expecting 2000 from client", [], {
    _aiCall: stub({
      mode: "do",
      message: "Adding expected income.",
      intent: { kind: "add_income", params: { name: "Client", amountCents: 200000 } },
    }),
  });
  assertEq(r.kind, "clarify");
  assertEq(r.field, "expectedDate");
  assertTrue(!!s.pendingDraft);
  assertEq(s.pendingDraft.missingField, "expectedDate");
});

test("[pipeline] clarify on add_income then 'next monday' → resolved", async () => {
  let s = fullySetUp();
  const todayStr = m.today(s.timezone || "UTC");
  s.pendingDraft = {
    intent: { kind: "add_income", params: { name: "Client", amountCents: 200000 } },
    missingField: "expectedDate",
    ts: Date.now(),
    expiresAt: Date.now() + 60000,
    turnCount: 0,
  };
  const r = await processMessage(s, "next monday", [], {
    _aiCall: async () => "",
  });
  assertEq(r.kind, "do");
  assertEq(r.intent.kind, "add_income");
  assertTrue(!!r.intent.params.expectedDate);
});
