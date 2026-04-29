"use strict";
// LLM-as-judge. Takes a scenario + final transcript + final state and grades
// the run on three axes:
//   1. Mechanical correctness (did expected outcomes happen?)
//   2. Conversation quality (warm, brief, natural, no loops, no robot vibes?)
//   3. UX alignment (did the user actually get what they wanted?)
//
// Returns { score: 1-10, verdict: "pass"|"fail", reasons: [...], fixes: [...] }
//
// Two stages:
//   - Mechanical check: deterministic, runs first (fast, no API call).
//   - LLM check: only if mechanical passes. Reads the transcript like a human.

const { getBackend } = require("./ai-backend");

// ── Mechanical check ──
function mechanicalCheck(scenario, result) {
  const out = { passed: true, reasons: [] };
  const exp = scenario.expect || {};
  const s = result.finalState || {};

  if (exp.setup !== undefined && s.setup !== exp.setup) {
    out.passed = false;
    out.reasons.push("setup expected " + exp.setup + " got " + s.setup);
  }
  if (exp.balanceCents !== undefined && s.balanceCents !== exp.balanceCents) {
    out.passed = false;
    out.reasons.push("balance expected " + exp.balanceCents + " got " + s.balanceCents);
  }
  if (exp.paydayPattern && (!s.payday || !exp.paydayPattern.test(s.payday))) {
    out.passed = false;
    out.reasons.push("payday " + JSON.stringify(s.payday) + " did not match " + exp.paydayPattern);
  }
  if (exp.bills) {
    const have = Object.keys(s.bills || {}).sort();
    const want = exp.bills.slice().sort();
    if (have.join(",") !== want.join(",")) {
      out.passed = false;
      out.reasons.push("bills expected " + JSON.stringify(want) + " got " + JSON.stringify(have));
    }
  }
  if (exp.minTransactions !== undefined) {
    const n = (s.transactions || []).length;
    if (n < exp.minTransactions) {
      out.passed = false;
      out.reasons.push("transactions expected ≥" + exp.minTransactions + " got " + n);
    }
  }
  if (exp.forbidPhrases) {
    const allBotText = botMessagesText(result.transcript);
    for (const re of exp.forbidPhrases) {
      if (re.test(allBotText)) {
        out.passed = false;
        out.reasons.push("FORBIDDEN phrase appeared: " + re);
      }
    }
  }
  return out;
}

function botMessagesText(transcript) {
  return transcript.filter(e => e.dir === "←").map(e => e.text || "").join("\n---\n");
}

// ── LLM judge ──
async function llmJudge(scenario, result) {
  const aiCall = getBackend();
  const transcript = result.rendered;
  const finalState = result.finalState;

  const system = [
    "You are a strict, expert UX reviewer for a personal-finance Telegram bot called SpendYes.",
    "You'll get: a scenario description, a final state, and a chat transcript.",
    "Your job: grade the experience as a real person would feel it.",
    "",
    "GRADE ON:",
    "1. NATURAL — does it feel like a friend or a wizard? 1 (form-like) → 10 (effortlessly conversational).",
    "2. CLEAR — does the user always know what's happening? Any confusion? 1 (lost) → 10 (crystal).",
    "3. EFFICIENT — minimum messages to outcome? 1 (bot bloats) → 10 (lean).",
    "4. WARM — tone right? Not robotic, not over-friendly? 1 (cold) → 10 (just right).",
    "5. SAFE — never asks twice for what was given, never loops, never says 'setting up' if already set up.",
    "",
    "OUTPUT STRICT JSON:",
    '{"scores":{"natural":N,"clear":N,"efficient":N,"warm":N,"safe":N},"overall":N,"verdict":"pass"|"fail","critique":["short bullet 1","..."],"fixes":["concrete code/prompt fix 1","..."]}',
    "",
    "Verdict: pass if overall ≥ 7 AND safe ≥ 9. fail otherwise.",
    "Be honest. Brutal honesty > flattery. We use this to actually fix the product.",
  ].join("\n");

  // Convert cents → dollar string for the judge so it doesn't read raw cents
  // as inflated dollar amounts ("300000" → it'll think $300k, not $3k).
  const fmtUsd = (cents) => {
    if (typeof cents !== "number") return cents;
    return "$" + (cents / 100).toFixed(2);
  };

  const user = [
    "SCENARIO: " + scenario.name,
    "DESCRIPTION: " + (scenario.description || "(none)"),
    "",
    "FINAL STATE (money values shown as dollars for clarity):",
    JSON.stringify({
      setup: finalState && finalState.setup,
      balance: finalState ? fmtUsd(finalState.balanceCents) : null,
      payday: finalState && finalState.payday,
      payFrequency: finalState && finalState.payFrequency,
      bills: finalState && Object.keys(finalState.bills || {}),
      txCount: finalState && (finalState.transactions || []).length,
      eventCount: finalState && (finalState.events || []).length,
    }, null, 2),
    "",
    "TRANSCRIPT:",
    transcript,
  ].join("\n");

  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const raw = await aiCall(messages);
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    return {
      scores: { natural: 0, clear: 0, efficient: 0, warm: 0, safe: 0 },
      overall: 0,
      verdict: "fail",
      critique: ["judge JSON parse failed: " + e.message + " // raw: " + raw.slice(0, 200)],
      fixes: [],
    };
  }
}

async function judge(scenario, result, options) {
  const opts = options || {};
  const mech = mechanicalCheck(scenario, result);
  let llm = null;
  if (!opts.skipLLM) {
    try {
      llm = await llmJudge(scenario, result);
    } catch (e) {
      llm = {
        scores: {}, overall: 0, verdict: "fail",
        critique: ["judge call failed: " + e.message],
        fixes: [],
      };
    }
  }
  return { mechanical: mech, llm };
}

module.exports = { judge, mechanicalCheck };
