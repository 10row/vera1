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
const { recordWarning } = require("./ai-debug");

// Backdate resolver. The AI is NON-DETERMINISTIC about emitting the
// `date` param: same prompt + same message can yield date OR no date
// across calls. Verified with two back-to-back real-AI runs — one
// emitted "2026-05-03", the next omitted it entirely. For a money
// tracker, "usually works" isn't AAA — so this resolver provides a
// deterministic fallback.
//
// USAGE: pipeline calls resolveBackdateFromText(userMessage, todayStr)
// AFTER the AI returns. If a high-confidence time marker is found AND
// the AI's record_* intent has no date param, the resolver returns the
// ISO date to inject. Otherwise null (no inject).
//
// PRECISION OVER RECALL: only fires on UNAMBIGUOUS markers. Phrases
// where the time-word might describe context (not the action) are
// excluded — e.g. "yesterday's leftovers" (apostrophe-s) is naturally
// rejected by \byesterday\b because of word-boundary semantics.
//
// FALSE-POSITIVE GUARD: confirm card shows the resolved date — user
// sees " · yesterday" before tapping Yes. A wrong inject is visible,
// not silent corruption.
//
// EN: \b word-boundaries work fine for Latin script.
// RU: \b is ASCII-only in JS regex. Cyrillic words need (?:^|[^\p{L}])
//     lookarounds with the /u flag for proper word matching.
const BACKDATE_RESOLVERS = [
  // English — yesterday → today − 1
  { rx: /\byesterday\b/i, offset: -1, label: "yesterday" },
  // English — N days ago → today − N
  { rx: /\b(\d+)\s+days?\s+ago\b/i, offsetFromMatch: m => -parseInt(m[1], 10), label: "N days ago" },
  // English — last weekday → most-recent matching weekday before today
  { rx: /\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i,
    offsetFromMatch: (m, todayStr) => offsetForLastWeekday(m[1], todayStr), label: "last weekday" },
  // Russian — вчера → today − 1
  { rx: /(?:^|[^\p{L}])вчера(?=[^\p{L}]|$)/iu, offset: -1, label: "вчера" },
  // Russian — позавчера → today − 2
  { rx: /(?:^|[^\p{L}])позавчера(?=[^\p{L}]|$)/iu, offset: -2, label: "позавчера" },
  // Russian — N дней/дня/день назад → today − N
  { rx: /(\d+)\s+(?:дней|дня|день)\s+назад/iu, offsetFromMatch: m => -parseInt(m[1], 10), label: "N дней назад" },
];

const WEEKDAY_INDEX = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
function offsetForLastWeekday(name, todayStr) {
  const target = WEEKDAY_INDEX[name.toLowerCase()];
  if (target == null) return 0;
  const today = new Date(todayStr + "T00:00:00Z");
  const cur = today.getUTCDay();
  // "last X" = most recent X strictly before today. Same-day → 7 days back.
  let diff = cur - target;
  if (diff <= 0) diff += 7;
  return -diff;
}

// Returns { date, label } or null. The label is for /debug breadcrumbs.
function resolveBackdateFromText(text, todayStr) {
  if (!text || !todayStr) return null;
  for (const r of BACKDATE_RESOLVERS) {
    const match = r.rx.exec(text);
    if (!match) continue;
    let offset;
    if (typeof r.offset === "number") offset = r.offset;
    else if (typeof r.offsetFromMatch === "function") offset = r.offsetFromMatch(match, todayStr);
    if (!Number.isFinite(offset) || offset >= 0) continue; // must be in the past
    return { date: m.addDays(todayStr, offset), label: r.label };
  }
  return null;
}

// Legacy alias kept for tripwire diagnostics — same patterns, just
// returns the matched word for the warning message.
function userMentionsPastTime(text) {
  const r = resolveBackdateFromText(text, m.today("UTC"));
  return r ? r.label : null;
}

// ── PROMISE-ACTION CONSISTENCY ────────────────────────────────
// THE silent-lie failure mode: AI's text says "I'll adjust your balance"
// but no adjust_balance intent is emitted. Bot ships the promise, nothing
// happens, user is confused. We detect this here and rewrite the reply
// to an honest "I'm not sure what to do — be more specific?" rather than
// shipping a lie.
//
// Action-verb patterns. Each fires ON ANY MODE (do / do_batch / talk).
// The patterns are TIGHT: first-person + present-progressive or future,
// followed by a money-action OBJECT pronoun (it / that / the X / your X).
// "I'll add support for that feature" → won't trip (no it/that/balance/spend/etc.).
// "Undoing it"                         → trips (it = previous action).
// "Adjusting your balance"             → trips (your balance).
//
// The cost of a false positive: an honest "couldn't pin down" reply.
// The cost of a false negative: bot lies. False positives MUCH preferable.
const ACTION_VERBS = {
  en: [
    // Undo phrasings — most common silent-lie surface (user reported case).
    [/\b(undoing|reverting|reversing)\s+(it|that|the\s+\w+|your\s+\w+|last)\b/i, ["undo_last"]],
    [/\bi(?:'ll| will| am going to)\s+(undo|revert|reverse)\b/i, ["undo_last"]],
    // Adjust / set balance / update payday.
    [/\b(adjusting|setting|updating|changing)\s+(your\s+)?(balance|payday)/i, ["adjust_balance", "update_payday"]],
    [/\bi(?:'ll| will| am going to)\s+(adjust|update|set|change)\s+(your\s+)?(balance|payday)/i, ["adjust_balance", "update_payday"]],
    // Log spend / income.
    [/\b(logging|recording)\s+(it|that|the\s+\w+|your\s+\w+|\$|that spend|that income)/i, ["record_spend", "record_income"]],
    [/\bi(?:'ll| will| am going to)\s+(log|record)\s+(it|that|the\s+\w+|your\s+\w+|\$)/i, ["record_spend", "record_income"]],
    // Add bill / remove bill — only when followed by a bill-context object.
    [/\b(adding|saving)\s+(the|your)?\s*(bill|rent|subscription)/i, ["add_bill"]],
    [/\bi(?:'ll| will| am going to)\s+add\s+(the|your)?\s*(bill|rent|subscription)/i, ["add_bill"]],
    [/\b(removing|deleting)\s+(it|that|the\s+\w+|your\s+\w+)\b/i, ["remove_bill", "undo_last", "delete_transaction"]],
    [/\bi(?:'ll| will| am going to)\s+(remove|delete)\s+(it|that|the\s+\w+|your\s+\w+)\b/i, ["remove_bill", "undo_last", "delete_transaction"]],
    // Generic "marking as paid" — must have record_spend with billKey.
    [/\b(marking|paying)\s+(it|that|the\s+\w+|your\s+\w+)\s*(as\s+)?(paid)?/i, ["record_spend"]],
  ],
  ru: [
    // Cyrillic note: JS \b uses [A-Za-z0-9_] for word boundaries — does NOT
    // recognize Cyrillic. Use start-of-string or non-letter via lookarounds.
    [/(?:^|[^\p{L}])(отменяю|откатываю|возвращаю)\s+(это|то|последн)/iu, ["undo_last"]],
    [/(?:^|[^\p{L}])(исправляю|меняю|обновляю|корректирую)\s+(баланс|зарплату)/iu, ["adjust_balance", "update_payday"]],
    [/(?:^|[^\p{L}])(записываю|логирую|добавляю)\s+(это|то|трату|доход)/iu, ["record_spend", "record_income"]],
    [/(?:^|[^\p{L}])(удаляю|убираю)\s+(это|то|счёт|счет)/iu, ["remove_bill", "undo_last", "delete_transaction"]],
  ],
};

// Returns null if consistent. Returns rewritten honest reply if AI
// promised an action it didn't emit.
//
// FIRES ON ALL MODES (do / do_batch / talk). The user-reported bug
// (\"undoing it now\" in talk mode + no undo_last intent) was slipping
// through because the previous version short-circuited talk mode.
// Tight verb patterns above keep false positives low.
//
// ask_simulate stays exempt — that mode is read-only by contract.
function detectSilentLie(proposal, lang) {
  if (!proposal || !proposal.message) return null;
  if (proposal.mode === "ask_simulate") return null;

  const text = proposal.message;
  const verbs = ACTION_VERBS[lang === "ru" ? "ru" : "en"] || ACTION_VERBS.en;

  const proposedKinds = new Set();
  if (proposal.intent && proposal.intent.kind) proposedKinds.add(proposal.intent.kind);
  if (Array.isArray(proposal.intents)) {
    for (const i of proposal.intents) if (i && i.kind) proposedKinds.add(i.kind);
  }

  for (const [re, expectedKinds] of verbs) {
    if (!re.test(text)) continue;
    const ok = expectedKinds.some(k => proposedKinds.has(k));
    if (!ok) {
      return lang === "ru"
        ? "_(хм — я сказал, что сделаю, но не сделал. Попробуй ещё раз более явно — например \"отмени последнее\" или \"измени баланс на 5000\".)_"
        : "_(I said I'd do it but didn't actually do it — bad. Try again more explicitly — e.g. \"undo last\" or \"adjust balance to 5000\".)_";
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

  // ── FOREIGN-CURRENCY CONVERSION ──
  // AI emits originalAmount (natural number) + originalCurrency for
  // foreign spends. We convert to base-currency subunits BEFORE the
  // engine sees it. Pipeline stores BOTH on the intent so display can
  // show "₫200,000 ≈ $8".
  //
  // Backward-compat: if AI still sends the older `originalAmountCents`
  // (some prompts cached?), interpret it as the spoken number / 100
  // for currencies with 2 decimals. Best effort.
  const currency = require("./currency");
  function convertOnce(intent) {
    if (!intent || !intent.params) return intent;
    const p = intent.params;
    let originalAmount = p.originalAmount;
    // Backward-compat for older AI outputs that used originalAmountCents.
    if (originalAmount == null && Number.isFinite(p.originalAmountCents) && p.originalAmountCents > 0) {
      const dec = currency.decimalsFor(p.originalCurrency);
      // For 2-decimal currencies, "Cents" = subunits / 100 = whole-unit.
      // For 0-decimal (VND/JPY), the AI was confused — treat the value as whole units.
      originalAmount = dec === 2 ? p.originalAmountCents / 100 : p.originalAmountCents;
      // Normalize: remove the legacy field, use new one.
      p.originalAmount = originalAmount;
      delete p.originalAmountCents;
    }
    if (p.originalCurrency && Number.isFinite(originalAmount) && originalAmount > 0) {
      const base = state.currency || "USD";
      const fromSubunits = currency.spokenToSubunits(originalAmount, p.originalCurrency);
      const toSubunits = currency.convertSubunits(fromSubunits, p.originalCurrency, base);
      // amountCents in our codebase = base-currency subunits (cents for USD).
      p.amountCents = toSubunits;
    }
    return intent;
  }
  if (proposal.intent) convertOnce(proposal.intent);
  if (Array.isArray(proposal.intents)) proposal.intents.forEach(convertOnce);

  // ── BACKDATE AUTO-INJECT (deterministic safety net) ──
  // Verified empirically: the AI is NON-DETERMINISTIC about emitting
  // the `date` param — same prompt + same message can give date OR no
  // date across consecutive calls. For AAA reliability we inject the
  // date deterministically when the user's message has an unambiguous
  // past-time marker AND the AI dropped it.
  //
  // Confirm card shows the resolved date so any false positive is
  // visible to the user before they tap Yes — never silent corruption.
  //
  // Only fires for record_spend / record_income (the dateable intents).
  try {
    const todayStr = m.today((state && state.timezone) || "UTC");
    const resolved = resolveBackdateFromText(userMessage, todayStr);
    if (resolved) {
      const dateableKinds = new Set(["record_spend", "record_income"]);
      const tryInject = (intent) => {
        if (!intent || !dateableKinds.has(intent.kind)) return false;
        if (!intent.params) intent.params = {};
        if (intent.params.date) return false; // AI emitted; respect it
        intent.params.date = resolved.date;
        return true;
      };
      const injected = [];
      if (proposal.intent && tryInject(proposal.intent)) injected.push("intent");
      if (Array.isArray(proposal.intents)) {
        proposal.intents.forEach((it, i) => { if (tryInject(it)) injected.push("intents[" + i + "]"); });
      }
      // Diagnostic breadcrumb in /debug — auto-inject is transparent,
      // not silent. Lets us see when the safety net actually fired.
      const debugKey = (options && options._debugUserId != null) ? options._debugUserId : null;
      if (injected.length > 0 && debugKey != null) {
        recordWarning(debugKey,
          "ℹ auto-injected date=" + resolved.date + " (\"" + resolved.label +
          "\") onto " + injected.length + " intent(s) — AI dropped it.");
      }
    }
  } catch { /* never block the user-facing flow */ }

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

module.exports = { processMessage, detectSilentLie };
