"use strict";
// Step 5 — Voice output tests.
// TTS module: text-rewrite for spoken delivery + injectable synth + graceful failure.

const tts = require("../tts");
const m = require("../model");
const { applyIntent } = require("../engine");

// ── textForVoice: pure rewrite from markdown to spoken-friendly ─────
test("[STEP5] textForVoice strips markdown emphasis", () => {
  const out = tts.textForVoice("*Calm* — _$45/day_");
  assertTrue(!out.includes("*"));
  assertTrue(!out.includes("_"));
});

test("[STEP5] textForVoice strips backticks", () => {
  const out = tts.textForVoice("Use `/voice on` to enable");
  assertTrue(!out.includes("`"));
});

test("[STEP5] textForVoice strips emoji", () => {
  const out = tts.textForVoice("🟢 Calm — $45/day");
  assertTrue(!out.includes("🟢"));
  assertTrue(!out.includes("🟡"));
  assertTrue(!out.includes("🔴"));
});

test("[STEP5] textForVoice converts $ amounts to 'X dollars'", () => {
  assertTrue(tts.textForVoice("$45").includes("45 dollars"));
  assertTrue(tts.textForVoice("$1,234.56").includes("1,234.56 dollars"));
  assertTrue(tts.textForVoice("$5/day").includes("5 dollars per day"));
});

test("[STEP5] textForVoice handles other currencies", () => {
  assertTrue(tts.textForVoice("€50").includes("50 euros"));
  assertTrue(tts.textForVoice("₽5000").includes("5000 rubles"));
  assertTrue(tts.textForVoice("£20").includes("20 pounds"));
});

test("[STEP5] textForVoice converts /day /wk /mo to spoken form", () => {
  assertTrue(tts.textForVoice("$5/day").includes("per day"));
  assertTrue(tts.textForVoice("$30/wk").includes("per week"));
  assertTrue(tts.textForVoice("$120/mo").includes("per month"));
});

test("[STEP5] textForVoice replaces · and — dividers with comma", () => {
  const out1 = tts.textForVoice("$45 · 12 days");
  assertTrue(out1.includes(","));
  assertTrue(!out1.includes("·"));
  const out2 = tts.textForVoice("Calm — easy");
  assertTrue(out2.includes(","));
  assertTrue(!out2.includes("—"));
});

test("[STEP5] textForVoice caps at 100 words", () => {
  const long = Array(200).fill("word").join(" ");
  const out = tts.textForVoice(long);
  const words = out.split(/\s+/);
  assertTrue(words.length <= 101); // 100 + final period
});

test("[STEP5] textForVoice on empty input returns empty", () => {
  assertEq(tts.textForVoice(""), "");
  assertEq(tts.textForVoice(null), "");
  assertEq(tts.textForVoice(undefined), "");
});

test("[STEP5] textForVoice produces a clean readable string for hero line", () => {
  const out = tts.textForVoice("🟢 *Calm* — $45/day · 12 days to payday");
  // Should be free of all formatting
  assertTrue(!out.match(/[*_`🟢🟡🔴·—]/));
  assertTrue(out.includes("45 dollars per day"));
  assertTrue(out.includes("12 days to payday"));
});

// ── synthesize: injectable, returns audio buffer or null ─────────
test("[STEP5] synthesize calls injected _tts with cleaned text", async () => {
  let received = null;
  const stub = async (t) => { received = t; return Buffer.from("audio"); };
  const buf = await tts.synthesize("*Calm* — $45/day", { _tts: stub });
  assertTrue(Buffer.isBuffer(buf));
  assertTrue(received.includes("45 dollars per day"));
  assertTrue(!received.includes("*"));
});

test("[STEP5] synthesize falls back to null on TTS failure (no throw)", async () => {
  const failingStub = async () => { throw new Error("network down"); };
  const buf = await tts.synthesize("hello", { _tts: failingStub });
  assertEq(buf, null); // graceful — caller falls back to text-only
});

test("[STEP5] synthesize on empty text returns null without calling TTS", async () => {
  let called = false;
  const stub = async () => { called = true; return Buffer.from("audio"); };
  const buf = await tts.synthesize("", { _tts: stub });
  assertEq(buf, null);
  assertEq(called, false);
});

test("[STEP5] synthesize on TTS returning empty buffer returns null", async () => {
  const stub = async () => Buffer.alloc(0);
  const buf = await tts.synthesize("hi", { _tts: stub });
  assertEq(buf, null);
});

// ── State plumbing: voiceReplies in fresh state and update_settings ───
test("[STEP5] fresh state has voiceReplies=false by default", () => {
  const s = m.createFreshState();
  assertEq(s.voiceReplies, false);
});

test("[STEP5] update_settings can toggle voiceReplies", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 1_000_00 } }).state;
  assertEq(s.voiceReplies, false);
  s = applyIntent(s, { kind: "update_settings", params: { voiceReplies: true } }).state;
  assertEq(s.voiceReplies, true);
  s = applyIntent(s, { kind: "update_settings", params: { voiceReplies: false } }).state;
  assertEq(s.voiceReplies, false);
});

test("[STEP5] update_settings ignores non-boolean voiceReplies", () => {
  let s = m.createFreshState();
  s = applyIntent(s, { kind: "setup_account", params: { balanceCents: 1_000_00 } }).state;
  s = applyIntent(s, { kind: "update_settings", params: { voiceReplies: "yes" } }).state;
  assertEq(s.voiceReplies, false);
});
