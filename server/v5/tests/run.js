"use strict";
// Tiny test runner. node server/v5/tests/run.js [file...]

const fs = require("fs");
const path = require("path");

const tests = [];
let failed = 0;

global.test = (name, fn) => tests.push({ name, fn });
global.assertEq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg ? msg + ": " : "") + "expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
  }
};
global.assertTrue = (cond, msg) => { if (!cond) throw new Error(msg || "assert failed"); };
global.assertThrows = (fn, pattern) => {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  if (!threw) throw new Error("Expected throw");
  if (pattern && !pattern.test(err.message)) {
    throw new Error("Wrong error: " + err.message + " (expected " + pattern + ")");
  }
};

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(__dirname).filter(f => f.endsWith(".test.js")).map(f => path.join(__dirname, f));

for (const f of files) require(path.resolve(f));

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log("✓ " + t.name);
    } catch (e) {
      failed++;
      console.error("✗ " + t.name);
      console.error("  " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n  ") : e));
    }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  process.exit(failed > 0 ? 1 : 0);
})();
