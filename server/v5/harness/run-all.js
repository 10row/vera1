"use strict";
// Runs all scenarios in server/v5/harness/scenarios, grades each, prints
// a summary, exits non-zero if any failed.
//
// Usage:
//   node server/v5/harness/run-all.js                      # all
//   node server/v5/harness/run-all.js 01 02                # only matching
//   node server/v5/harness/run-all.js --skip-llm           # mechanical only (fast)
//   node server/v5/harness/run-all.js --transcripts        # print transcripts
//
// Writes per-scenario reports under server/v5/harness/reports/<run-id>/.

require("dotenv").config({ override: true });

const fs = require("fs");
const path = require("path");
const { runScenario } = require("./driver");
const { judge } = require("./judge");

const ARGS = process.argv.slice(2);
const SKIP_LLM = ARGS.includes("--skip-llm");
const SHOW_TRANSCRIPTS = ARGS.includes("--transcripts");
const FILTER_TOKENS = ARGS.filter(a => !a.startsWith("--"));

const SCEN_DIR = path.join(__dirname, "scenarios");
const REPORT_ROOT = path.join(__dirname, "reports");

function loadScenarios() {
  const files = fs.readdirSync(SCEN_DIR).filter(f => f.endsWith(".js")).sort();
  const out = [];
  for (const f of files) {
    if (FILTER_TOKENS.length > 0 && !FILTER_TOKENS.some(t => f.includes(t))) continue;
    const scen = require(path.join(SCEN_DIR, f));
    out.push(scen);
  }
  return out;
}

(async () => {
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error("No scenarios matched.");
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(REPORT_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const results = [];
  let failures = 0;

  console.log("Running " + scenarios.length + " scenarios… (runId=" + runId + ")\n");

  for (const scen of scenarios) {
    process.stdout.write("→ " + scen.name + " ... ");
    let res;
    try {
      res = await runScenario(scen);
    } catch (e) {
      console.log("CRASH: " + e.message);
      failures++;
      results.push({ scenario: scen.name, crashed: true, error: e.message });
      continue;
    }
    let g;
    try {
      g = await judge(scen, res, { skipLLM: SKIP_LLM });
    } catch (e) {
      g = { mechanical: { passed: false, reasons: ["judge crash: " + e.message] }, llm: null };
    }

    const passMech = g.mechanical.passed;
    const passLlm = SKIP_LLM ? true : (g.llm && g.llm.verdict === "pass");
    const pass = passMech && passLlm;

    if (pass) {
      const score = SKIP_LLM ? "" : (g.llm ? " [score " + g.llm.overall + "/10]" : "");
      console.log("OK" + score);
    } else {
      failures++;
      console.log("FAIL");
      if (!passMech) {
        for (const r of g.mechanical.reasons) console.log("    mech: " + r);
      }
      if (!SKIP_LLM && g.llm) {
        console.log("    score: " + g.llm.overall + "/10  verdict: " + g.llm.verdict);
        for (const c of (g.llm.critique || [])) console.log("    UX: " + c);
        for (const f of (g.llm.fixes || [])) console.log("    fix: " + f);
      }
    }

    results.push({ scenario: scen.name, pass, mechanical: g.mechanical, llm: g.llm, transcript: res.rendered });
    fs.writeFileSync(
      path.join(runDir, scen.name + ".txt"),
      "# " + scen.name + "\n# pass=" + pass + " mech=" + passMech + " llm=" + (passLlm ? "pass" : "fail") + "\n\n" +
      "## TRANSCRIPT\n" + res.rendered + "\n\n" +
      "## MECHANICAL\n" + JSON.stringify(g.mechanical, null, 2) + "\n\n" +
      "## LLM JUDGE\n" + JSON.stringify(g.llm, null, 2) + "\n\n" +
      "## FINAL STATE\n" + JSON.stringify(res.finalState, null, 2)
    );

    if (SHOW_TRANSCRIPTS) {
      console.log("\n--- transcript ---");
      console.log(res.rendered);
      console.log("--- end ---\n");
    }
  }

  console.log("\n" + (scenarios.length - failures) + "/" + scenarios.length + " passed");
  console.log("Reports: " + runDir);

  // Also write a summary.json for tooling.
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    runId,
    total: scenarios.length,
    passed: scenarios.length - failures,
    failed: failures,
    results: results.map(r => ({ name: r.scenario, pass: r.pass, mech: r.mechanical, llm: r.llm })),
  }, null, 2));

  process.exit(failures > 0 ? 1 : 0);
})();
