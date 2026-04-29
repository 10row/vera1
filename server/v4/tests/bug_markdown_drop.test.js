"use strict";
// Regression test — user reported:
//   "When I press confirm on something I lose the next message and it
//    kind of ends. Major UX bug."
//
// Root: Telegram silently DROPS messages with unbalanced Markdown.
// User-supplied envelope names / notes containing * or _ broke the
// markdown in confirm cards and post-confirm summaries.
//
// Fix: escapeMd() helper applied to every user-controlled string before
// it reaches a parse_mode:"Markdown" message. Also: validator returns
// plain-text reasons (no inline markdown around user names). Plus a
// safeReply/safeEdit pattern in the bot that retries without parse_mode
// if Telegram rejects the markdown — defense in depth.

const m = require("../model");
const { applyIntent } = require("../engine");
const { validateIntent } = require("../validator");

// ── escapeMd ────────────────────────────────────────────
test("[BUG-MD] escapeMd handles markdown specials", () => {
  assertEq(m.escapeMd("plain"), "plain");
  assertEq(m.escapeMd("Save *for* Vietnam"), "Save \\*for\\* Vietnam");
  assertEq(m.escapeMd("dinner_with_friends"), "dinner\\_with\\_friends");
  assertEq(m.escapeMd("`code`"), "\\`code\\`");
  assertEq(m.escapeMd("[link]"), "\\[link\\]");
  assertEq(m.escapeMd(null), "");
  assertEq(m.escapeMd(undefined), "");
  // Round-trip with non-markdown is identity
  assertEq(m.escapeMd("Vietnam Hotel"), "Vietnam Hotel");
});

test("[BUG-MD] escapeMd preserves balance: every escaped char has a backslash", () => {
  const tricky = "*_`[]";
  const escaped = m.escapeMd(tricky);
  // 5 specials → 5 backslashes
  const backslashes = (escaped.match(/\\/g) || []).length;
  assertEq(backslashes, 5);
});

// ── Validator no longer emits markdown around user names ────
test("[BUG-MD] add_envelope rejection text adds NO markdown around user name", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 5000_00 } }).state;
  // Use a user name WITHOUT markdown chars so we can isolate validator's
  // own markdown emission.
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 1500_00 },
  }).state;
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Vietnam Hotel", kind: "goal", amountCents: 700_00 },
  });
  assertEq(v.ok, false);
  // No bare asterisks should appear — validator emits plain text.
  // Bot wraps the whole reason in italics for display.
  const stars = (v.reason.match(/\*/g) || []).length;
  assertEq(stars, 0, "validator must not emit raw asterisks; got: " + v.reason);
  // No bare underscores either.
  const undies = (v.reason.match(/_/g) || []).length;
  assertEq(undies, 0, "validator must not emit raw underscores; got: " + v.reason);
});

test("[BUG-MD] markdown specials in user name pass through validator without crashing the bot", () => {
  // The bot wraps the validator's reason in _..._ for italics. If the
  // user's name contains _ or *, the bot escapes them. So the validator
  // can include the raw name; the bot does the escaping at render time.
  // Here we just verify the validator returns SOME reason (doesn't throw).
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 5000_00 } }).state;
  s = applyIntent(s, {
    kind: "add_envelope",
    params: { name: "Save *for* Vietnam", kind: "goal", amountCents: 1500_00 },
  }).state;
  const v = validateIntent(s, {
    kind: "add_envelope",
    params: { name: "Save *for* Vietnam", kind: "goal", amountCents: 700_00 },
  });
  assertEq(v.ok, false);
  assertTrue(typeof v.reason === "string" && v.reason.length > 0);
});

// ── escapeMd produces output safe for parse_mode: "Markdown" ────
test("[BUG-MD] escaped envelope name + balanced asterisks survives concat with bot markdown", () => {
  const userName = "Save *for* Vietnam";
  const rendered = "📌 Add bill · " + m.escapeMd(userName) + " · $1,000";
  // Count backslashes vs literal asterisks in the escaped portion
  const escapedAsterisks = (rendered.match(/\\\*/g) || []).length;
  assertEq(escapedAsterisks, 2, "user asterisks should be escaped in output");
  // No bare * remaining in the escaped span (the literal isn't bare; backslash precedes)
  const escapedSpan = m.escapeMd(userName);
  assertEq(escapedSpan, "Save \\*for\\* Vietnam");
});

// ── Locale parity for the new key ────────────────────────
test("[BUG-MD] confirm.done exists in en + ru", () => {
  const en = require("../locales/en");
  const ru = require("../locales/ru");
  assertTrue(typeof en["confirm.done"] === "string");
  assertTrue(typeof ru["confirm.done"] === "string");
});
