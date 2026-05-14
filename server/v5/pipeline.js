"use strict";
// v5/pipeline.js — orchestrate one user message into one outcome.
//
// Outcome shapes (returned to bot):
//   { kind: "onboarding", reply, intent?, draft?, clearDraft?, done }
//   { kind: "talk", message }
//   { kind: "do", message, intent, verdict }
//   { kind: "do_batch", message, items: [{intent, verdict}, ...] }   // brain-dump
//   { kind: "decision", message, simulate }     // "can I afford X"
//   { kind: "clarify", message, field, code }   // ASK user — NO BUTTONS
//
// CLARIFY exists so the bot has a clean way to ask a follow-up question
// when the AI emitted an intent but a required field (e.g. dueDate) is
// missing. Pre-clarify, the validator hard-rejected with a reason string
// and the bot wrapped it in Yes/No buttons — confusing because the user
// hadn't supplied enough to confirm anything. The new path: validator
// returns { ok:false, clarify:{...} } → pipeline forwards as
// kind:"clarify" → bot replies in plain text. No buttons. The user types
// the missing piece and the AI re-runs the intent.
//
// Pipeline NEVER mutates state. Bot applies intents after the user confirms.

const m = require("./model");
const { parseProposal } = require("./ai");
const { validateIntent } = require("./validator");
const { simulateSpend, compute } = require("./view");
const onboarding = require("./onboarding");
const { recordWarning } = require("./ai-debug");

// ── COMMITMENT-SHAPE DETECTION ───────────────────────────────
// When the AI emits record_spend for what's actually a one-time
// commitment ("200 euro for friend's wedding"), default record_spend
// behavior eats today's discretionary allowance — pace today drops by
// the full amount. That's wrong for spends the user thinks of as
// "planned commitments I should track but shouldn't affect today's
// budget."
//
// Detection signal: amount SIGNIFICANT relative to daily pace AND the
// note/message contains a commitment marker (wedding / trip / gift /
// deposit / etc., or "for [event]" framing).
//
// When detected, the pipeline emits kind:"commitment_choice" with TWO
// paths the user can pick on the confirm card:
//   A. Spend today (record_spend) — eats today's daily
//   B. Commitment (add_bill once + record_spend with billKey)
//      — balance drops, bill clears, pace unchanged
// The user taps the option that matches their mental model.

// Commitment-object keywords. Detection requires "for X" framing OR
// the keyword appears AS the object of "for".
const COMMITMENT_OBJECTS_EN = "(?:trip|vacation|holiday|wedding|anniversary|birthday|graduation|engagement|honeymoon|funeral|party|celebration|baby\\s*shower|christening|gift|present|deposit|down\\s*payment|retainer|fundraiser|charity|donation|loan|tickets?)";
const COMMITMENT_OBJECTS_RU = "(?:поездк\\w*|отпуск\\w*|путешеств\\w*|командировк\\w*|свадьб\\w*|юбилей\\w*|выпускн\\w*|праздник\\w*|подарок|подарк\\w*|подарки|залог\\w*|депозит\\w*|аванс\\w*|помолвк\\w*|похорон\\w*|вечеринк\\w*)";

// Strong: "for [the/my/his/her/...] X" where X is a commitment object.
// Also catches "X gift" / "X trip" suffixes.
const COMMITMENT_STRONG_EN = new RegExp(
  "\\b(?:for\\s+(?:the\\s+|a\\s+|an\\s+|my\\s+|his\\s+|her\\s+|our\\s+|their\\s+|[a-z]+'s\\s+)?" + COMMITMENT_OBJECTS_EN
  + "|" + COMMITMENT_OBJECTS_EN + "\\s+(?:for|gift|present))\\b",
  "i"
);
// Russian commitment framing: "для X" / "на X" / "к X-у" where X is a commitment object.
const COMMITMENT_STRONG_RU = new RegExp(
  "(?:^|[^\\p{L}])(?:для|на|к)\\s+" + COMMITMENT_OBJECTS_RU,
  "iu"
);
// Day-of-week + ISO + relative-date markers — used to detect whether
// the user actually said a date (and so AI's dueDate is real, not
// invented). Used by the "never invent dueDate" safety net.
const DATE_MARKERS_EN = /\b(today|tomorrow|tonight|yesterday|mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rsday)?|fri(day)?|sat(urday)?|sun(day)?|in\s+\d+\s+(day|days|week|weeks|month|months)|next\s+(week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this\s+(week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)|the\s+\d+(st|nd|rd|th)|on\s+the\s+\d+|by\s+(today|tomorrow|the\s+\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+(week|month)|next\s+\w+|\d+|\w+\s+\d+)|until\s+|end\s+of\s+(week|month|year)|\d{4}-\d{2}-\d{2}|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const DATE_MARKERS_RU = /(?:^|[^\p{L}])(?:сегодня|завтра|вчера|послезавтра|понедельник\w*|вторник\w*|сред[ауые]|четверг\w*|пятниц[ауые]|суббот[ауые]|воскресень[еяю]|через\s+\d+|на\s+следующ[ую]\w*\s+недел\w*|к\s+\d+|к\s+понедельник\w*|к\s+вторник\w*|к\s+сред[еу]|к\s+четверг\w*|к\s+пятниц[еу]|к\s+суббот[еу]|к\s+воскресень[ю]|до\s+\d+|\d{1,2}-?го|\d{1,2}\s+числа|январ\w*|феврал\w*|март\w*|апрел\w*|мая?\b|июн\w*|июл\w*|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*|конц[еа]\s+(недели|месяца|года))/iu;

function userMessageMentionsDate(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return false;
  return DATE_MARKERS_EN.test(userMessage) || DATE_MARKERS_RU.test(userMessage);
}

// Returns true if THIS record_spend looks like a planned commitment
// rather than today's discretionary. Conservative — only fires on
// strong signals (commitment keyword + significant amount).
function isCommitmentShape(state, intent, userMessage) {
  if (!intent || intent.kind !== "record_spend") return false;
  const p = intent.params || {};
  // Bill-payment record_spend (billKey set) is ALREADY a commitment —
  // no need to offer a choice.
  if (p.billKey) return false;
  // Has-date record_spend (backdated) is recording the past — the
  // choice belongs to TODAY's logging only.
  if (p.date) return false;
  const amt = Math.round(Number(p.amountCents) || 0);
  if (amt <= 0) return false;

  // Threshold: the COMMITMENT MARKER is the strong signal; amount only
  // gates trivial spends. Floor at $30 absolute (so a $5 "gift for mom"
  // doesn't fire) and at half a day's pace (so users with huge daily
  // budgets don't see the card on relatively-tiny amounts). The 0.5×
  // multiplier handles the $200-vs-$166-pace case from the user-
  // reported bug where 1.5× was too strict to fire on a clearly-
  // commitment-shaped spend.
  const MIN_ABS_CENTS = 3000;
  if (amt < MIN_ABS_CENTS) return false;
  let view;
  try { view = compute(state); } catch { return false; }
  const pace = view && Number.isFinite(view.dailyPaceCents) ? view.dailyPaceCents : 0;
  if (pace > 0 && amt < Math.round(pace * 0.5)) return false;

  // Look at note + vendor + raw user message for commitment markers.
  const haystack = String(p.note || "") + " " + String(p.vendor || "") + " " + String(userMessage || "");
  const strong = COMMITMENT_STRONG_EN.test(haystack) || COMMITMENT_STRONG_RU.test(haystack);
  return !!strong;
}

// Derive a clean bill name from the user's note. Goal: a name the user
// will recognize in the bills section (not "for friend's wedding gift").
// Patterns (in order):
//   1. vendor → use it
//   2. "for [the/my/...] X [more]" → X (capitalize)
//   3. "X for Y" (gift for mom) → "X for Y"
//   4. Strip leading "for " then capitalize
//   5. Take first 4 words of note, capitalize
//   6. Fallback "Commitment"
function deriveCommitmentName(note, vendor, lang) {
  const isRu = lang === "ru";
  const fallback = isRu ? "Обязательство" : "Commitment";
  if (vendor && String(vendor).trim()) return capitalizeName(String(vendor).trim());
  if (!note || typeof note !== "string") return fallback;
  const cleaned = note.trim().replace(/[.!?]+$/, "");

  // "for [the/my/his/her/our/their/a/an] X [more]" — strip generic
  // determiners only. Named possessives (Friend's, mom's, sarah's)
  // STAY in the name — "Friend's wedding" reads better than just
  // "Wedding" because the user said WHOSE wedding.
  const forMatch = /^for\s+(?:the\s+|a\s+|an\s+|my\s+|his\s+|her\s+|our\s+|their\s+)?(.{2,60}?)\s*$/i.exec(cleaned);
  if (forMatch) return capitalizeName(forMatch[1]);
  // "X for Y" (e.g. "gift for mom")
  const xForY = /^(.{2,30})\s+for\s+(.{2,30})$/i.exec(cleaned);
  if (xForY) return capitalizeName(xForY[1] + " for " + xForY[2]);
  // Russian: "для X" / "на X" / "к X"
  const ruFor = /^(?:для|на|к)\s+(.{2,60}?)\s*$/iu.exec(cleaned);
  if (ruFor) return capitalizeName(ruFor[1]);

  // Generic: take first 4 words
  const words = cleaned.split(/\s+/).slice(0, 4).join(" ");
  return capitalizeName(words) || fallback;
}
function capitalizeName(s) {
  if (!s) return "";
  return s.trim().replace(/\s+/g, " ").replace(/^./, c => c.toUpperCase());
}

// Build the [add_bill, record_spend(billKey)] batch for the
// commitment path. Both share the SAME billKey so engine matches them.
function buildCommitmentBatch(state, spendIntent, lang) {
  const p = spendIntent.params || {};
  const todayStr = m.today((state && state.timezone) || "UTC");
  const billName = deriveCommitmentName(p.note, p.vendor, lang);
  // De-dup: if user already has a bill with this name, suffix with date.
  let finalName = billName;
  if (state.bills) {
    const key = m.billKey(billName);
    if (state.bills[key]) finalName = billName + " (" + todayStr + ")";
  }
  const addBill = {
    kind: "add_bill",
    params: {
      name: finalName,
      amountCents: p.amountCents,
      // Preserve foreign-currency info on the bill so display can show it.
      originalAmount: p.originalAmount,
      originalCurrency: p.originalCurrency,
      dueDate: todayStr,
      recurrence: "once",
      category: p.category,
    },
  };
  const payBill = {
    kind: "record_spend",
    params: Object.assign({}, p, {
      billKey: m.billKey(finalName),
      note: p.note || finalName,
    }),
  };
  return [addBill, payBill];
}

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

// ── FORWARD-DATE RESOLVER ────────────────────────────────────
// Sibling to resolveBackdateFromText. Used by the pendingDraft
// mechanism: when the validator clarifies a missing dueDate and the
// user replies "tomorrow" / "next friday" / "in 3 days" / "the 15th",
// we resolve the phrase deterministically and merge into the pending
// intent. No AI round-trip, failsafe.
//
// PRECISION OVER RECALL: only fires on unambiguous markers. Same
// principle as the backdate resolver.
const FORWARD_DATE_RESOLVERS = [
  // MORE SPECIFIC FIRST: "day after tomorrow" must match before
  // "tomorrow" (which would otherwise greedily catch the substring).
  // English — day after tomorrow → today + 2
  { rx: /\bday after tomorrow\b/i, offset: 2, label: "day after tomorrow" },
  // English — tomorrow → today + 1
  { rx: /^tomorrow$|\btomorrow\b/i, offset: 1, label: "tomorrow" },
  // English — in N days
  { rx: /\bin\s+(\d+)\s+days?\b/i, offsetFromMatch: m => parseInt(m[1], 10), label: "in N days" },
  // English — in N weeks → today + N*7
  { rx: /\bin\s+(\d+)\s+weeks?\b/i, offsetFromMatch: m => parseInt(m[1], 10) * 7, label: "in N weeks" },
  // English — next week → today + 7
  { rx: /\bnext\s+week\b/i, offset: 7, label: "next week" },
  // English — next weekday → next occurrence of weekday after today
  { rx: /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i,
    offsetFromMatch: (mm, todayStr) => offsetForNextWeekday(mm[1], todayStr), label: "next weekday" },
  // English — bare weekday → next occurrence (including today only if explicit "this")
  { rx: /\b(this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    offsetFromMatch: (mm, todayStr) => offsetForNextWeekday(mm[2], todayStr), label: "weekday" },
  // English — "the 15th" / "the 1st" / "on the Nth"
  { rx: /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
    offsetFromMatch: (mm, todayStr) => offsetForDayOfMonth(parseInt(mm[1], 10), todayStr), label: "day of month" },
  // Russian — завтра → today + 1
  { rx: /(?:^|[^\p{L}])завтра(?=[^\p{L}]|$)/iu, offset: 1, label: "завтра" },
  // Russian — послезавтра → today + 2
  { rx: /(?:^|[^\p{L}])послезавтра(?=[^\p{L}]|$)/iu, offset: 2, label: "послезавтра" },
  // Russian — через N дней / через неделю
  { rx: /через\s+(\d+)\s+(?:дней|дня|день)/iu, offsetFromMatch: m => parseInt(m[1], 10), label: "через N дней" },
  { rx: /через\s+неделю/iu, offset: 7, label: "через неделю" },
  { rx: /через\s+(\d+)\s+недел[ьи]/iu, offsetFromMatch: m => parseInt(m[1], 10) * 7, label: "через N недель" },
  // Russian — в понедельник / во вторник etc.
  { rx: /\bв(?:о)?\s+(понедельник|вторник|сред[уy]|четверг|пятниц[уy]|суббот[уy]|воскресенье)\b/iu,
    offsetFromMatch: (mm, todayStr) => offsetForNextWeekday(mapRuWeekday(mm[1]), todayStr), label: "RU weekday" },
];

const RU_WEEKDAYS = {
  "понедельник": "monday", "вторник": "tuesday", "среду": "wednesday", "среды": "wednesday",
  "четверг": "thursday", "пятницу": "friday", "пятницы": "friday",
  "субботу": "saturday", "субботы": "saturday", "воскресенье": "sunday",
};
function mapRuWeekday(name) {
  return RU_WEEKDAYS[name.toLowerCase()] || name;
}
function offsetForNextWeekday(name, todayStr) {
  const target = WEEKDAY_INDEX[String(name || "").toLowerCase()];
  if (target == null) return 0;
  const today = new Date(todayStr + "T00:00:00Z");
  const cur = today.getUTCDay();
  // "next X" = next occurrence STRICTLY AFTER today. Same-day → 7 days forward.
  let diff = target - cur;
  if (diff <= 0) diff += 7;
  return diff;
}
function offsetForDayOfMonth(day, todayStr) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return -1; // invalid
  const today = new Date(todayStr + "T00:00:00Z");
  const curDay = today.getUTCDate();
  // "the 15th" in current month if not yet passed; else next month.
  let target = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day));
  if (curDay >= day) {
    target = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day));
  }
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target.getTime() - todayMs) / 86400000);
}

// resolveForwardDateFromText — returns { date, label } or null.
function resolveForwardDateFromText(text, todayStr) {
  if (!text || !todayStr) return null;
  // ISO date passes through if valid + in future / today.
  const iso = m.normalizeDate(String(text).trim());
  if (iso && iso >= todayStr) return { date: iso, label: "iso" };
  for (const r of FORWARD_DATE_RESOLVERS) {
    const match = r.rx.exec(text);
    if (!match) continue;
    let offset;
    if (typeof r.offset === "number") offset = r.offset;
    else if (typeof r.offsetFromMatch === "function") offset = r.offsetFromMatch(match, todayStr);
    if (!Number.isFinite(offset) || offset < 0) continue; // must be today or future
    return { date: m.addDays(todayStr, offset), label: r.label };
  }
  return null;
}

// ── PENDING DRAFT — clarify-state across turns ────────────────
// When validator emits a clarify ("when's it due?"), the pipeline now
// persists the partial intent on state.pendingDraft. On the next turn,
// PHASE 1.7 of processMessage tries to deterministically resolve the
// missing field from the user's reply. If resolved, we merge and
// re-validate — bypassing the AI entirely. If not resolved within the
// expiry window or 3 turns, we give up and route normally.
//
// Bug-report: dry-cleaning loop (2026-05-13). User said "dry cleaning
// 3150 thb tomorrow", AI dropped the date, bot asked "when?", user
// said "tomorrow", AI couldn't reconstruct the bill from history,
// asked again. The loop is fundamental — every clarify path had it.
const PENDING_DRAFT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PENDING_DRAFT_MAX_TURNS = 3;

function makePendingDraft(intent, missingField, now) {
  const ts = (typeof now === "number" ? now : Date.now());
  return {
    intent,
    missingField,
    ts,
    expiresAt: ts + PENDING_DRAFT_TTL_MS,
    turnCount: 0,
  };
}

// resolvePendingField — given a missing field name and the user's raw
// reply, return the resolved value or null. Strict resolvers; ambiguous
// inputs → null (fall through to AI).
function resolvePendingField(field, text, state) {
  const todayStr = m.today((state && state.timezone) || "UTC");
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  if (field === "dueDate" || field === "expectedDate") {
    const r = resolveForwardDateFromText(trimmed, todayStr);
    return r ? r.date : null;
  }
  if (field === "amountCents") {
    // Bare number "3150" or "3150 thb" or "$50" → cents. Use the
    // currency parser if available; else simple float match.
    try {
      const ccy = require("./currency");
      // parseAmount can handle "3150", "3150 thb", "$50", etc.
      const parsed = ccy.parseAmount ? ccy.parseAmount(trimmed, (state && state.currency) || "USD") : null;
      if (parsed && Number.isFinite(parsed.amountCents) && parsed.amountCents > 0) {
        return parsed.amountCents;
      }
    } catch { /* fall through */ }
    // Fallback: simple "<number>" parse, assume base currency dollars.
    const numMatch = trimmed.match(/^[$€£¥₽฿]?\s*(\d+(?:[.,]\d{1,2})?)\s*$/);
    if (numMatch) {
      const dollars = parseFloat(numMatch[1].replace(",", "."));
      if (Number.isFinite(dollars) && dollars > 0) {
        return Math.round(dollars * 100);
      }
    }
    return null;
  }
  if (field === "recurrence") {
    const t2 = trimmed.toLowerCase();
    if (/^(once|one[- ]?time|just once|разово|один раз|однократно)$/.test(t2)) return "once";
    if (/^(monthly|every month|ежемесячно|каждый месяц)$/.test(t2)) return "monthly";
    if (/^(weekly|every week|еженедельно|каждую неделю)$/.test(t2)) return "weekly";
    if (/^(biweekly|every two weeks|every other week|раз в две недели|каждые две недели)$/.test(t2)) return "biweekly";
    return null;
  }
  if (field === "name") {
    // Reject pure numbers, very short / very long, "yes"/"no", commands.
    if (/^\/|^(yes|no|ok|да|нет|сброс|cancel|stop)$/i.test(trimmed)) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return null;
    if (trimmed.length < 2 || trimmed.length > 60) return null;
    return trimmed;
  }
  return null;
}

// tryResolvePending — examine state.pendingDraft against userMessage.
// Returns:
//   { resolved: { intent, missingField } } — pendingDraft was matched + merged
//   { expired: true } — pendingDraft was too old or hit turn limit
//   { miss: true } — pendingDraft alive but didn't match this turn
//   null — no pendingDraft at all
function tryResolvePending(state, userMessage, now) {
  const pd = state && state.pendingDraft;
  if (!pd || !pd.intent || !pd.missingField) return null;
  const nowMs = (typeof now === "number" ? now : Date.now());
  if (pd.expiresAt && nowMs >= pd.expiresAt) return { expired: true };
  if (pd.turnCount != null && pd.turnCount >= PENDING_DRAFT_MAX_TURNS) return { expired: true };

  const resolvedValue = resolvePendingField(pd.missingField, userMessage, state);
  if (resolvedValue == null) return { miss: true };

  // Merge into intent.params under the missing field name.
  const mergedIntent = {
    kind: pd.intent.kind,
    params: Object.assign({}, pd.intent.params || {}, { [pd.missingField]: resolvedValue }),
  };
  return { resolved: { intent: mergedIntent, missingField: pd.missingField, resolvedValue } };
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
// scrubFabricatedNumbers — defensive failsafe against AI hallucinated
// projection numbers in ask_simulate / answer modes. The AI's message
// must not contain $X/day, $X left, drop to $X, etc. — the bot computes
// real numbers via simulate() and renders them as a separate line.
//
// Without this, the user sees two contradicting numbers (AI's fiction
// + bot's truth) in the same reply. Trust-killer for a money tool.
//
// Pattern detection is INTENTIONALLY broad — false-positive cost is a
// generic message ("Yes — manageable.") which is harmless; false-
// negative cost is shipped-fiction next to truth, which is the bug.
//
// `mode` arg gates: only applied to ask_simulate today. Future answer
// modes can opt in here.
const FABRICATED_NUMBER_PATTERNS = [
  /\$\s*\d[\d,]*(?:\.\d+)?\s*\/\s*day/i,        // "$X/day" or "$X.XX / day"
  /\$\s*\d[\d,]*(?:\.\d+)?\s+(?:less|more|left|available|saved|spare)\b/i,
  /\b(?:drop|fall|rise|jump|climb)\s+to\s+\$\s*\d/i,
  /\bafter\s+(?:that)?[^.]{0,30}\$\s*\d/i,
  /\bfor\s+\d+\s+days?\b/i,
  // Cyrillic variants
  /\$?\s*\d[\d,]*(?:\.\d+)?\s*\/\s*день/i,
  /(?:упадёт|упадет|снизится|вырастет)\s+до\s+\$/i,
  // Bare "$X" left over from the patterns above can still slip through;
  // the patterns above catch the most common shapes. We don't strip
  // single $X mentions (those can be the user's own quoted amount).
];
function scrubFabricatedNumbers(message, mode) {
  if (!message || typeof message !== "string") return message;
  if (mode !== "ask_simulate") return message; // only mode that's structurally guaranteed to fabricate
  const hasFiction = FABRICATED_NUMBER_PATTERNS.some(p => p.test(message));
  if (!hasFiction) return message;
  // Drop the entire message — bot's computed line will carry the real
  // answer. Empty string causes the bot's render to skip the AI text
  // and lead with the computed answer (the right thing).
  // Diagnostic: caller can pick up the original via the breadcrumb if
  // needed (not implemented yet — keep simple).
  return "";
}

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


// ── STATUS-CHECK DETECTION (deterministic, no AI) ──────────
// The user-most-common question — "what's available today?" / "how
// am I doing?" / "where am I at?" — has a DETERMINISTIC answer (the
// canonical daily snapshot from state). No AI judgment needed.
//
// This was a real failure mode: the user asked "what's available
// today?" and the AI quoted disposable (cycle-level) instead of
// today's-left (daily). Wrong dimension. Bot looked dumb.
//
// Fix: pattern-match the most common status phrasings BEFORE the AI
// call. Skip the AI entirely. Bot renders the snapshot from state.
//   - Zero hallucination risk
//   - Zero AI cost / latency
//   - Works when AI is down
//   - Same canonical output every time
//
// Patterns are TIGHT — anchored to the FULL trimmed message so we
// don't fire on "I spent 5 today" or "what's available in the food
// budget" (which would belong to the AI). Status questions are
// short and lack additional context.
//
// Locale-aware: covers EN + RU phrasings. AI prompt has a safety
// net (Layer 1) for phrasings the regex misses.
const STATUS_PATTERNS_EN = [
  /^(how('m| am) i doing|how am i looking|how do i look)$/,
  /^(where('m| am) i (at|right now)?|where do i stand)$/,
  /^(what'?s? (the |my )?(status|picture|number|numbers))$/,
  /^(what'?s? available( today)?)$/,
  /^(available today)$/,
  /^(show me (today|the picture|my numbers|the numbers))$/,
  /^(my (status|numbers|picture))$/,
  /^(today'?s? (number|situation|status|picture))$/,
  /^(today)$/,
  /^(status)$/,
  /^(how much (do i have|can i spend) (today|right now)?)$/,
  /^(how am i)$/,
  /^(check in)$/,
  /^(give me the picture)$/,
  /^(tell me where i'?m at)$/,
];
const STATUS_PATTERNS_RU = [
  /^(как дела(?: с деньгами)?)$/,
  /^(как я( сегодня)?)$/,
  /^(как у меня дела)$/,
  /^(что у меня (сегодня|сейчас))$/,
  /^(что доступно( сегодня)?)$/,
  /^(доступно сегодня)$/,
  /^(сколько у меня (сегодня|сейчас))$/,
  /^(сколько (я )?(могу )?потратить сегодня)$/,
  /^(мо[яй] (картина|статус|числа|число))$/,
  /^(мои числа)$/,
  /^(мой статус)$/,
  /^(статус)$/,
  /^(сегодня)$/,
  /^(где я( сейчас)?)$/,
  /^(покажи (сегодня|мои числа|картину|статус))$/,
  /^(моё число (сегодня)?)$/,
];
function isStatusQuestion(text, lang) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim().toLowerCase().replace(/[?!.,]+$/, "").replace(/\s+/g, " ");
  // Length gate: status questions are short. >80 chars likely something else.
  if (t.length < 3 || t.length > 80) return false;
  const patterns = lang === "ru"
    ? [...STATUS_PATTERNS_RU, ...STATUS_PATTERNS_EN]
    : [...STATUS_PATTERNS_EN, ...STATUS_PATTERNS_RU];
  return patterns.some(rx => rx.test(t));
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

  // ── PHASE 1.5: pending-draft resolution (clarify across turns) ──
  // MUST run BEFORE the status check because date words like "today" /
  // "tomorrow" would otherwise be caught as status questions. The user
  // is actively answering a clarify, so resolution takes priority.
  //
  // If a previous turn emitted a clarify ("when's it due?"), state has
  // a pendingDraft with the partial intent + missing field. Try to
  // resolve the user's reply deterministically. On hit → merge →
  // validate → emit result (NO AI call). On miss → fall through;
  // increment turnCount or expire.
  //
  // Bug-report 0007: dry-cleaning loop. User said "tomorrow" repeatedly
  // and the bot kept asking for a date because the AI couldn't
  // reconstruct the bill from history. This fixes the root for ALL
  // clarify paths (dueDate, amountCents, recurrence, name).
  if (state.pendingDraft) {
    const lang = state.language === "ru" ? "ru" : "en";
    const resolution = tryResolvePending(state, userMessage, Date.now());
    if (resolution && resolution.resolved) {
      // Successful merge — clear pendingDraft and emit result.
      state.pendingDraft = null;
      const mergedIntent = resolution.resolved.intent;
      const todayStr = m.today((state && state.timezone) || "UTC");
      const verdict = validateIntent(state, mergedIntent, todayStr, lang);
      if (verdict && !verdict.ok && verdict.clarify) {
        // Still missing something else — set a fresh pendingDraft for the new field.
        state.pendingDraft = makePendingDraft(mergedIntent, verdict.clarify.field, Date.now());
        return {
          kind: "clarify",
          message: verdict.clarify.question,
          field: verdict.clarify.field,
          code: verdict.clarify.code,
        };
      }
      return {
        kind: "do",
        message: verdict && verdict.ok
          ? (lang === "ru" ? "Понял — подтверди:" : "Got it — confirm:")
          : (lang === "ru" ? "Хм, не получилось:" : "Hmm, couldn't apply:"),
        intent: mergedIntent,
        verdict,
      };
    }
    if (resolution && resolution.expired) {
      // Too old / too many tries — clear it and fall through to normal AI.
      state.pendingDraft = null;
    } else if (resolution && resolution.miss) {
      // Alive, didn't match — increment turn count, KEEP pendingDraft.
      state.pendingDraft = Object.assign({}, state.pendingDraft, {
        turnCount: (state.pendingDraft.turnCount || 0) + 1,
      });
      // Fall through to AI; user might be answering with extra context.
    }
  }

  // ── PHASE 1.6: status check — short-circuit before AI ──
  // Most-asked question on the bot; deterministic answer; no AI call.
  // Failsafe: works when OpenAI is down / out of quota. Runs AFTER
  // pendingDraft resolution so date words like "today" can complete a
  // clarify before being interpreted as a status question.
  if (isStatusQuestion(userMessage, state.language)) {
    return { kind: "status" };
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
      // Pass the tx event date to convertSubunits so backdated spends
      // get the historical rate from THAT day. If no date on the
      // intent yet (auto-inject runs AFTER this convert), the rate
      // function falls back to most-recent live rate, which is fine —
      // for current-day spends that's correct; for backdates, the
      // rate is at most a few days off (auto-inject will set the
      // tx.date on the engine side, but the converted amountCents
      // is already settled here). Could re-convert on engine apply if
      // we want perfect historical accuracy on backdates; for now
      // most-recent rate is the AAA tradeoff.
      const dateISO = p.date || null;
      const toSubunits = currency.convertSubunits(fromSubunits, p.originalCurrency, base, dateISO);
      // amountCents in our codebase = base-currency subunits (cents for USD).
      p.amountCents = toSubunits;
    }
    return intent;
  }
  // ── BACKDATE AUTO-INJECT (deterministic safety net) ──
  // Runs BEFORE currency conversion so the conversion can use the
  // historical rate for backdated spends.
  //
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
        // CRITICAL: validate the AI's date BEFORE deciding to respect
        // it. The AI sometimes emits literal strings like "yesterday"
        // as a date param (verified from a real bug report). A naive
        // truthiness check ("if (params.date)") would respect the
        // garbage, then the validator would throw "Invalid date
        // format — use YYYY-MM-DD."
        //
        // New rule: respect the AI's date ONLY if it's a valid ISO
        // YYYY-MM-DD. Otherwise inject the resolver's date — same
        // behavior as if the AI had dropped the field entirely.
        const aiValid = intent.params.date ? m.normalizeDate(intent.params.date) : null;
        if (aiValid) return false; // AI emitted valid ISO — respect it
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

  if (proposal.intent) convertOnce(proposal.intent);
  if (Array.isArray(proposal.intents)) proposal.intents.forEach(convertOnce);

  // ── STRIP INVENTED dueDate ON add_bill (deterministic safety net) ──
  // The AI prompt forbids inventing a dueDate when the user didn't say
  // one, but the AI is non-deterministic. If the user message has NO
  // date markers (no weekday, no "the Nth", no "in N days", no ISO),
  // but the AI emitted a dueDate, we strip it. Validator then runs the
  // clarify path — bot asks "by when?". This was a real user-reported
  // bug: "200 for friends trip" → AI guessed today → bot reserved with
  // today's date without asking.
  //
  // SCOPE: only `recurrence: "once"` add_bills are subject to the
  // strip. Recurring bills (monthly/weekly/biweekly) have a naturally
  // derivable dueDate from the cycle ("rent due the 1st" implies
  // next 1st), so stripping there causes a false "by when?" clarify
  // even though the AI's dueDate is correct.
  try {
    const stripped = [];
    const stripDate = (intent, label) => {
      if (!intent || intent.kind !== "add_bill" || !intent.params) return;
      const rec = intent.params.recurrence;
      // Only strip for one-time set-asides. Recurring bills' dates are OK.
      if (rec && rec !== "once") return;
      if (intent.params.dueDate && !userMessageMentionsDate(userMessage)) {
        delete intent.params.dueDate;
        stripped.push(label);
      }
    };
    stripDate(proposal.intent, "intent");
    if (Array.isArray(proposal.intents)) proposal.intents.forEach((it, i) => stripDate(it, "intents[" + i + "]"));
    const debugKey = (options && options._debugUserId != null) ? options._debugUserId : null;
    if (stripped.length > 0 && debugKey != null) {
      recordWarning(debugKey, "ℹ stripped invented dueDate on " + stripped.length + " add_bill(s) — user message had no date marker.");
    }
  } catch { /* never block flow */ }

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
    // FAILSAFE: scrub fabricated projection numbers from AI's message.
    // The AI literally cannot know the projection — it runs AFTER the
    // AI returns. Anything like "$X/day" / "drop to $Y" / "$Z left" in
    // the message is hallucinated. Bot renders the REAL computed line
    // below. Without this scrubber, user sees two contradicting numbers.
    // (Real bug from screenshot: "$140.54/day" AI fiction + "$131.69/day"
    // bot truth in the same reply. Trust-killer.)
    const cleanedMessage = scrubFabricatedNumbers(proposal.message, "ask_simulate");
    return {
      kind: "decision",
      message: cleanedMessage,
      amountCents: proposal.amountCents,
      simulate: sim,
      // Preserve the "what" so the bot's [Log it] button can create a
      // record_spend with a meaningful note instead of an empty one.
      // "Can I afford 200 for a jacket?" → tap Log → record_spend
      // includes note="jacket", category="personal", vendor=... if AI
      // captured them. Without this, every logged afford-check is a
      // noteless spend in history.
      note: proposal.note || undefined,
      vendor: proposal.vendor || undefined,
      category: proposal.category || undefined,
    };
  }

  if (proposal.mode === "do" && proposal.intent) {
    const todayStr = m.today((state && state.timezone) || "UTC");
    const verdict = validateIntent(state, proposal.intent, todayStr, lang);
    // CLARIFY: validator says the intent is well-formed but missing a
    // required field. Forward as kind:"clarify" so the bot renders the
    // question as plain text — NO confirm buttons. The user supplies
    // the missing piece on their next turn.
    //
    // PERSIST pendingDraft: carry the partial intent + missing field
    // across turns so PHASE 1.7 can deterministically resolve the next
    // user reply ("tomorrow") without going back through the AI. Fixes
    // the dry-cleaning loop bug at the architectural level.
    if (verdict && !verdict.ok && verdict.clarify) {
      state.pendingDraft = makePendingDraft(proposal.intent, verdict.clarify.field, Date.now());
      return {
        kind: "clarify",
        message: verdict.clarify.question,
        field: verdict.clarify.field,
        code: verdict.clarify.code,
      };
    }
    // Successful validation → user is no longer in a clarify flow.
    state.pendingDraft = null;
    // COMMITMENT_CHOICE: only fires for valid record_spend that looks
    // like a planned commitment. Pre-validates BOTH options so we can
    // show two paths only when both will succeed (else fall back to
    // regular do — no dead buttons).
    if (verdict && verdict.ok && isCommitmentShape(state, proposal.intent, userMessage)) {
      const commitmentBatch = buildCommitmentBatch(state, proposal.intent, lang);
      // Validate each commitment-batch intent against the projected
      // state. add_bill validates against current state directly;
      // record_spend(billKey) validates against post-add_bill state.
      const addBillVerdict = validateIntent(state, commitmentBatch[0], todayStr, lang);
      let payBillVerdict = { ok: false };
      if (addBillVerdict.ok) {
        try {
          const { applyIntent } = require("./engine");
          const projected = applyIntent(state, commitmentBatch[0]).state;
          payBillVerdict = validateIntent(projected, commitmentBatch[1], todayStr, lang);
        } catch { /* fall through */ }
      }
      // Only offer the choice if BOTH paths are valid. Else degrade
      // gracefully to single-option do (the regular spend).
      if (addBillVerdict.ok && payBillVerdict.ok) {
        return {
          kind: "commitment_choice",
          message: proposal.message,
          spendIntent: proposal.intent,
          commitmentBatch,
        };
      }
    }
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
    // Validate each. If ANY item comes back as clarify, surface that as
    // a single clarify reply — we can't show a confirm card while one
    // of the batch items is missing required info. (Rare: AI usually
    // either gives complete intents or none.)
    const items = proposal.intents.map(intent => ({
      intent,
      verdict: validateIntent(state, intent, todayStr, lang),
    }));
    const firstClarify = items.find(i => i.verdict && !i.verdict.ok && i.verdict.clarify);
    if (firstClarify) {
      // PERSIST pendingDraft for the FIRST clarify only. After that
      // batch item is resolved, the next turn re-runs the AI which
      // re-emits the (now-larger) batch — including the resolved
      // field. Multi-clarify within one batch isn't common enough to
      // warrant per-item queues.
      state.pendingDraft = makePendingDraft(firstClarify.intent, firstClarify.verdict.clarify.field, Date.now());
      return {
        kind: "clarify",
        message: firstClarify.verdict.clarify.question,
        field: firstClarify.verdict.clarify.field,
        code: firstClarify.verdict.clarify.code,
      };
    }
    state.pendingDraft = null;
    return {
      kind: "do_batch",
      message: proposal.message,
      items,
    };
  }

  // talk fallback — DEFENSIVE STRIP: the AI sometimes returns mode:"talk"
  // but also includes stray intent / intents fields (verified via /debug
  // ring buffer). Bot's old code didn't read them because mode said talk,
  // but the validator never saw them either — invisible silent-lie risk.
  // Strip them here so any future code that reads proposal.intent in
  // talk mode (e.g. analytics, logging) doesn't get confused.
  return {
    kind: "talk",
    message: proposal.message || "…",
  };
}

module.exports = {
  processMessage,
  detectSilentLie,
  // Exported for tests + diagnostic harness.
  isCommitmentShape,
  deriveCommitmentName,
  buildCommitmentBatch,
  userMessageMentionsDate,
  isStatusQuestion,
  resolveForwardDateFromText,
  resolvePendingField,
  tryResolvePending,
  makePendingDraft,
};
