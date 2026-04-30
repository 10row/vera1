#!/usr/bin/env node
"use strict";
// check-bug-protocol.js — pre-commit guard.
//
// If the current commit modifies any of the v5 core files
// (server/v5/{ai,pipeline,bot,validator,model,view}.js), check that a
// bug-reports/<id>/ directory was created or modified within the last 24h.
// If not, print a loud warning and exit non-zero — the commit is paused
// until the developer either:
//   a) creates the bug-reports/<id>/ directory with the artifacts, OR
//   b) bypasses with `git commit --no-verify` (logged below)
//
// This is the soft enforcement of the protocol. It is project-scoped
// only — does not affect any other repo on the machine.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CORE_FILES = [
  "server/v5/ai.js",
  "server/v5/pipeline.js",
  "server/v5/bot.js",
  "server/v5/validator.js",
  "server/v5/model.js",
  "server/v5/view.js",
  "server/v5/onboarding.js",
];

function staged() {
  try {
    return execSync("git diff --cached --name-only", { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch { return []; }
}

function hasRecentBugReport(maxAgeHours = 24) {
  const dir = path.join(process.cwd(), "bug-reports");
  if (!fs.existsSync(dir)) return false;
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    if (name === "_tmp") continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (st.mtimeMs >= cutoff) return true;
    // Also accept if the goldratt file was written recently.
    const g = path.join(p, "01-goldratt.md");
    if (fs.existsSync(g)) {
      const gst = fs.statSync(g);
      if (gst.mtimeMs >= cutoff) return true;
    }
  }
  return false;
}

const stagedFiles = staged();
const touchesCore = stagedFiles.some(f => CORE_FILES.includes(f));

if (!touchesCore) process.exit(0);

if (hasRecentBugReport()) {
  console.log("[bug-protocol] Recent bug-reports/<id>/ found — proceeding.");
  process.exit(0);
}

console.error("");
console.error("┌─────────────────────────────────────────────────────────────┐");
console.error("│ Bug-protocol check: warning                                 │");
console.error("├─────────────────────────────────────────────────────────────┤");
console.error("│ This commit modifies v5 core files but no bug-reports/<id>/ │");
console.error("│ was created in the last 24h. CLAUDE.md requires:            │");
console.error("│   1. Reproduce  (node server/v5/harness/repro.js \"...\")    │");
console.error("│   2. Goldratt   (bug-reports/<id>/01-goldratt.md)           │");
console.error("│   3. Variants   (node .../harness/variants.js bug.../<id>)  │");
console.error("│                                                             │");
console.error("│ If this is a non-bug change (refactor, docs, etc.)          │");
console.error("│ bypass with: git commit --no-verify                         │");
console.error("│ but log the reason in the commit message.                   │");
console.error("└─────────────────────────────────────────────────────────────┘");
console.error("");

// Soft-fail: exit non-zero so default git stops, but the message is friendly.
process.exit(1);
