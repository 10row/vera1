"use strict";
// One-time V2→V3 database migration helper.
// On first run: detects the old V2 schema (poolKey column) and force-resets.
// On subsequent runs: just does a normal `prisma db push`.

const { execSync } = require("child_process");

function run(cmd) {
  console.log(`[migrate] Running: ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    console.error(`[migrate] Command failed: ${cmd}`);
    process.exit(1);
  }
}

// Try normal db push first
try {
  execSync("prisma db push", { stdio: "pipe" });
  console.log("[migrate] prisma db push succeeded — schema is up to date.");
  process.exit(0);
} catch (e) {
  const msg = e.stderr ? e.stderr.toString() : e.stdout ? e.stdout.toString() : "";
  if (msg.includes("envelopeSpend") || msg.includes("envelopeKey") || msg.includes("cannot be executed")) {
    console.log("[migrate] Detected V2→V3 schema conflict. Force-resetting database...");
    run("prisma db push --force-reset --accept-data-loss");
    console.log("[migrate] V3 schema applied successfully.");
    process.exit(0);
  }
  // Some other error — just fail
  console.error("[migrate] Unexpected error during db push:");
  console.error(msg);
  process.exit(1);
}
