"use strict";
// v4/tts.js — text-to-speech wrapper. Pure with respect to state.
// Returns an audio buffer (opus, Telegram-friendly) or null on failure.
// All side effects (network) live behind an injectable `_tts` for testing.

// OpenAI is lazy-loaded so unit tests don't pay the import cost (and so
// pure helpers like textForVoice work without an OpenAI install).

const MODEL = "gpt-4o-mini-tts";
const VOICE = "alloy"; // calm, neutral. Swap to nova/shimmer/sage if we want a sharper personality later.
const MAX_WORDS = 100;

// Strip markdown / emoji / formatting that doesn't speak well; replace
// currency glyphs, slashes, and dividers with natural words.
// Pure function — fully unit-testable.
function textForVoice(text) {
  if (!text) return "";
  let s = String(text);
  // Strip markdown emphasis
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  // Strip common emoji ranges (covers our 🟢🟡🔴 and most symbols)
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{1F000}-\u{1F2FF}]/gu, "");
  // Currency glyphs → words
  s = s.replace(/\$(-?\d[\d,]*(?:\.\d+)?)/g, "$1 dollars");
  s = s.replace(/€(-?\d[\d,]*(?:\.\d+)?)/g, "$1 euros");
  s = s.replace(/₽(-?\d[\d,]*(?:\.\d+)?)/g, "$1 rubles");
  s = s.replace(/£(-?\d[\d,]*(?:\.\d+)?)/g, "$1 pounds");
  // Slashes → words for spoken reading
  s = s.replace(/\/day\b/gi, " per day");
  s = s.replace(/\/wk\b/gi, " per week");
  s = s.replace(/\/mo\b/gi, " per month");
  // Dividers / bullets → comma
  s = s.replace(/\s*[·•]\s*/g, ", ");
  s = s.replace(/\s*[—–]\s*/g, ", ");
  // Collapse whitespace, then enforce word cap
  s = s.replace(/\s+/g, " ").trim();
  const words = s.split(" ");
  if (words.length > MAX_WORDS) s = words.slice(0, MAX_WORDS).join(" ") + ".";
  return s;
}

async function defaultTts(text) {
  const OpenAI = require("openai");
  const openai = new OpenAI();
  const resp = await openai.audio.speech.create({
    model: MODEL,
    voice: VOICE,
    input: text,
    response_format: "opus",
  });
  return Buffer.from(await resp.arrayBuffer());
}

// synthesize(text, options?) → audio buffer or null.
// On TTS failure returns null (caller falls back to text-only invisibly).
// Options.{ _tts } injects a mock for tests.
async function synthesize(text, options) {
  const opts = options || {};
  const tts = opts._tts || defaultTts;
  const cleaned = textForVoice(text);
  if (!cleaned) return null;
  try {
    const buf = await tts(cleaned);
    if (!buf || (buf.length !== undefined && buf.length === 0)) return null;
    return buf;
  } catch (e) {
    console.warn("[v4 tts] synth failed, falling back to text:", e.message);
    return null;
  }
}

module.exports = { synthesize, textForVoice };
