"use strict";
// persona-judge.js — read a persona run's transcript and grade it.
//
// Usage:
//   node server/v5/harness/persona-judge.js harness/persona-runs/alex-<ts>
//
// Outputs:
//   <run>/judge.json — structured findings
//   <run>/found-bugs.md — bug-candidates the judge thinks deserve their
//                        own bug-reports/ entry

require("dotenv").config({ override: true });

const fs = require("fs");
const path = require("path");
const { getBackend } = require("./ai-backend");

async function judge(runDir) {
  const tPath = path.join(runDir, "transcript.json");
  if (!fs.existsSync(tPath)) throw new Error("Missing transcript: " + tPath);
  const tx = JSON.parse(fs.readFileSync(tPath, "utf8"));

  const ai = getBackend();
  const sys = [
    "You are a senior product reviewer for a personal-finance Telegram bot called SpendYes.",
    "You're auditing a real conversation between the bot and a user (a synthetic persona).",
    "Your job: identify problems, score the experience, and surface bug candidates.",
    "",
    "PERSONA:",
    JSON.stringify(tx.persona),
    "",
    "FINAL BOT STATE after the conversation:",
    JSON.stringify(tx.finalState),
    "",
    "DIMENSIONS to score (1-10 each):",
    "- mechanical_correctness: did the bot apply the right intents to the right amounts?",
    "- voice_consistency: did the bot stay in the persona's language across all turns?",
    "- conversational_quality: did it feel human, or robotic/looping?",
    "- intent_capture: did it capture EVERYTHING the user mentioned, or drop things?",
    "- ux_friction: how often did the user have to repeat / clarify / undo?",
    "",
    "OUTPUT STRICT JSON ONLY:",
    "{",
    "  \"scores\": { \"mechanical_correctness\": N, \"voice_consistency\": N, \"conversational_quality\": N, \"intent_capture\": N, \"ux_friction\": N },",
    "  \"overall\": N,",
    "  \"summary\": \"one sentence overall verdict\",",
    "  \"strengths\": [\"...\", \"...\"],",
    "  \"failures\": [\"specific failure 1\", \"specific failure 2\"],",
    "  \"bug_candidates\": [",
    "    { \"title\": \"short imperative\", \"symptom\": \"what user saw\", \"likely_layer\": \"prompt|data_model|onboarding|pipeline|bot|view\", \"severity\": \"high|medium|low\" }",
    "  ],",
    "  \"trustworthy\": true|false",
    "}",
  ].join("\n");

  const user = "FULL CONVERSATION:\n\n" + tx.conversation.map((c, i) =>
    "[" + (i + 1) + "] " + c.role.toUpperCase() + ": " + c.text
  ).join("\n");

  const raw = await ai([{ role: "system", content: sys }, { role: "user", content: user }]);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    // Try to recover JSON.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch {}
    }
    if (!parsed) parsed = { error: "judge JSON parse failed", raw: raw.slice(0, 500) };
  }

  fs.writeFileSync(path.join(runDir, "judge.json"), JSON.stringify(parsed, null, 2));

  // Bug-candidates → markdown for triage.
  const bugs = (parsed.bug_candidates || []).map((b, i) =>
    "## " + (i + 1) + ". " + b.title + " — " + b.severity + "\n" +
    "- **Symptom:** " + b.symptom + "\n" +
    "- **Likely layer:** " + b.likely_layer + "\n"
  ).join("\n");
  fs.writeFileSync(path.join(runDir, "found-bugs.md"),
    "# Bug candidates from " + tx.persona.id + "\n\n" +
    "Overall score: **" + (parsed.overall ?? "?") + "/10** — _" + (parsed.summary || "?") + "_\n\n" +
    "## Strengths\n" + (parsed.strengths || []).map(s => "- " + s).join("\n") + "\n\n" +
    "## Failures\n" + (parsed.failures || []).map(s => "- " + s).join("\n") + "\n\n" +
    "## Bug candidates\n\n" + (bugs || "_None._\n")
  );

  return parsed;
}

(async () => {
  const dir = process.argv[2];
  if (!dir) {
    // Run on every persona run that doesn't have a judge.json yet.
    const runDir = path.join(__dirname, "persona-runs");
    if (!fs.existsSync(runDir)) { console.log("No runs."); return; }
    const dirs = fs.readdirSync(runDir).map(d => path.join(runDir, d)).filter(d => fs.statSync(d).isDirectory());
    for (const d of dirs) {
      if (!fs.existsSync(path.join(d, "transcript.json"))) continue;
      if (fs.existsSync(path.join(d, "judge.json"))) continue;
      console.log("Judging " + path.basename(d) + "...");
      try {
        const v = await judge(d);
        console.log("  overall: " + (v.overall || "?") + "/10  — " + (v.summary || ""));
      } catch (e) {
        console.error("  judge failed: " + e.message);
      }
    }
    return;
  }
  const v = await judge(path.resolve(dir));
  console.log("overall: " + (v.overall || "?") + "/10");
  console.log("summary: " + (v.summary || ""));
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
