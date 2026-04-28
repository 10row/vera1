"use strict";
// Pre-deploy validation — run this locally before pushing.
// node test-v3-deploy.js

require("dotenv").config();
let pass = 0, fail = 0;

function assert(label, condition, detail) {
  if (condition) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.error("  ✗ " + label + (detail ? " — " + detail : "")); }
}

console.log("\n=== 1. REQUIRE CHAINS ===");
let v3, pic, query, sysPrompt, fmt, schema, aiMod;
try { v3 = require("./server/vera-v3"); assert("vera-v3 loads", true); } catch(e) { assert("vera-v3 loads", false, e.message); }
try { pic = require("./server/vera-v3-picture"); assert("vera-v3-picture loads", true); } catch(e) { assert("vera-v3-picture loads", false, e.message); }
try { query = require("./server/vera-v3-query"); assert("vera-v3-query loads", true); } catch(e) { assert("vera-v3-query loads", false, e.message); }
try { sysPrompt = require("./server/system-prompt"); assert("system-prompt loads", true); } catch(e) { assert("system-prompt loads", false, e.message); }
try { fmt = require("./server/tg-format-v3"); assert("tg-format-v3 loads", true); } catch(e) { assert("tg-format-v3 loads", false, e.message); }
try { schema = require("./server/openai-schema-v3"); assert("openai-schema-v3 loads", true); } catch(e) { assert("openai-schema-v3 loads", false, e.message); }
try { aiMod = require("./server/tg-ai-v3"); assert("tg-ai-v3 loads", true); } catch(e) { assert("tg-ai-v3 loads", false, e.message); }

console.log("\n=== 2. EXPORTS ===");
if (v3) {
  assert("v3.computePicture exists", typeof v3.computePicture === "function");
  assert("v3.runQuery exists", typeof v3.runQuery === "function");
  assert("v3.applyAction exists", typeof v3.applyAction === "function");
  assert("v3.toMoney exists", typeof v3.toMoney === "function");
  assert("v3.toCents exists", typeof v3.toCents === "function");
  assert("v3.createFreshState exists", typeof v3.createFreshState === "function");
  assert("v3.today exists", typeof v3.today === "function");
  assert("v3.envelopeReserve exists", typeof v3.envelopeReserve === "function");
}
if (pic) {
  assert("pic.computePicture exists", typeof pic.computePicture === "function");
  assert("pic.runQuery exists", typeof pic.runQuery === "function");
}
if (query) { assert("query.runQuery exists", typeof query.runQuery === "function"); }
if (sysPrompt) { assert("buildSystemPrompt exists", typeof sysPrompt.buildSystemPrompt === "function"); }
if (fmt) {
  assert("fmt.formatBriefing exists", typeof fmt.formatBriefing === "function");
  assert("fmt.heroLine exists", typeof fmt.heroLine === "function");
  assert("fmt.mainKeyboard exists", typeof fmt.mainKeyboard === "function");
  assert("fmt.dueButtons exists", typeof fmt.dueButtons === "function");
}
if (aiMod) {
  assert("callSpendYes exists", typeof aiMod.callSpendYes === "function");
  assert("callReview exists", typeof aiMod.callReview === "function");
}

console.log("\n=== 3. FRESH STATE ===");
if (v3) {
  const fresh = v3.createFreshState();
  assert("fresh state has setup:false", fresh.setup === false);
  assert("fresh state has envelopes:{}", typeof fresh.envelopes === "object" && Object.keys(fresh.envelopes).length === 0);
  assert("fresh state has transactions:[]", Array.isArray(fresh.transactions) && fresh.transactions.length === 0);
  assert("fresh state has conversationHistory:[]", Array.isArray(fresh.conversationHistory));

  const freshPic = v3.computePicture(fresh);
  assert("computePicture(fresh) returns {setup:false}", freshPic.setup === false);
  assert("computePicture(fresh) doesn't crash", true);
}

console.log("\n=== 4. SETUP + ACTIONS ===");
if (v3) {
  let s = v3.createFreshState();
  s = v3.applyAction(s, { type: "setup", data: { balanceUSD: 2000, payday: "2026-05-15", currency: "USD", symbol: "$" } });
  assert("setup sets setup:true", s.setup === true);
  assert("setup sets balanceCents:200000", s.balanceCents === 200000);
  assert("setup sets payday", s.payday !== null);
  assert("setup adds transaction", s.transactions.length === 1);

  const setupPic = v3.computePicture(s);
  assert("computePicture after setup has setup:true", setupPic.setup === true);
  assert("computePicture has freeCents", typeof setupPic.freeCents === "number");
  assert("computePicture has freeFormatted", typeof setupPic.freeFormatted === "string");
  assert("computePicture has dailyPaceCents", typeof setupPic.dailyPaceCents === "number");
  assert("computePicture has daysLeft", typeof setupPic.daysLeft === "number");
  assert("computePicture has envelopes array", Array.isArray(setupPic.envelopes));
  assert("computePicture has dueEnvelopes array", Array.isArray(setupPic.dueEnvelopes));
  assert("equation holds: reserves+free=balance", setupPic.checksumOk === true);

  // Create envelope
  s = v3.applyAction(s, { type: "create_envelope", data: { name: "Rent", amountUSD: 1400, rhythm: "monthly", nextDate: "2026-05-01", priority: "essential" } });
  assert("envelope created", s.envelopes.rent !== undefined);
  assert("envelope has correct amount", s.envelopes.rent.amountCents === 140000);

  // Spend
  const pre = s.balanceCents;
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 25.50, description: "lunch" } });
  assert("spend reduces balance", s.balanceCents === pre - 2550);
  assert("spend adds transaction", s.transactions.length === 2);

  // Income
  s = v3.applyAction(s, { type: "income", data: { amountUSD: 3000 } });
  assert("income increases balance", s.balanceCents > pre - 2550);
  assert("income resets cycle", s.cycleStart === v3.today());

  // Picture after all actions
  const finalPic = v3.computePicture(s);
  assert("final picture setup:true", finalPic.setup === true);
  assert("final equation holds", finalPic.checksumOk === true);
  assert("final freeCents is number", typeof finalPic.freeCents === "number");
}

console.log("\n=== 5. SYSTEM PROMPT ===");
if (sysPrompt && v3) {
  const s = v3.createFreshState();
  const prompt = sysPrompt.buildSystemPrompt(s);
  assert("prompt is string", typeof prompt === "string");
  assert("prompt has length > 100", prompt.length > 100);
  assert("prompt contains JSON instruction", prompt.includes("OUTPUT FORMAT"));
  assert("prompt contains word 'JSON'", prompt.includes("JSON"));
  assert("prompt contains action types", prompt.includes("create_envelope"));
  assert("prompt contains example structure", prompt.includes('"message"'));

  // After setup
  let s2 = v3.applyAction(s, { type: "setup", data: { balanceUSD: 1000, payday: "2026-05-15" } });
  const prompt2 = sysPrompt.buildSystemPrompt(s2);
  assert("setup prompt is string", typeof prompt2 === "string");
  assert("setup prompt contains STATE", prompt2.includes("STATE:"));
}

console.log("\n=== 6. FORMATTING ===");
if (fmt && v3) {
  const s = v3.applyAction(v3.createFreshState(), { type: "setup", data: { balanceUSD: 1000, payday: "2026-05-15" } });
  const p = v3.computePicture(s);
  const hero = fmt.heroLine(p, "en");
  assert("heroLine returns string", typeof hero === "string");
  assert("heroLine contains Free today", hero.includes("Free today"));

  const briefing = fmt.formatBriefing(p, "en");
  assert("briefing returns string", typeof briefing === "string");
  assert("briefing has content", briefing.length > 10);

  const notSetup = fmt.formatBriefing(null, "en");
  assert("briefing handles null pic", typeof notSetup === "string");

  const kb = fmt.mainKeyboard("en", null);
  assert("keyboard is object", typeof kb === "object");
  assert("keyboard has keyboard array", Array.isArray(kb.keyboard));

  const dueBtn = fmt.dueButtons("Rent", "en");
  assert("dueButtons returns inline_keyboard", Array.isArray(dueBtn.inline_keyboard));

  const recBtn = fmt.receiptButtons("en");
  assert("receiptButtons returns inline_keyboard", Array.isArray(recBtn.inline_keyboard));
}

console.log("\n=== 7. QUERIES ===");
if (query && v3) {
  let s = v3.applyAction(v3.createFreshState(), { type: "setup", data: { balanceUSD: 1000, payday: "2026-05-15" } });
  s = v3.applyAction(s, { type: "spend", data: { amountUSD: 30, description: "coffee" } });

  const mt = query.runQuery(s, { type: "month_total" }, v3.computePicture, v3.toMoney);
  assert("month_total returns spentCents", typeof mt.spentCents === "number");

  const se = query.runQuery(s, { type: "search_spend", keyword: "coffee", days: 30 }, v3.computePicture, v3.toMoney);
  assert("search_spend finds coffee", se.count >= 1);

  const proj = query.runQuery(s, { type: "projection" }, v3.computePicture, v3.toMoney);
  assert("projection returns verdict", typeof proj.verdict === "string");

  const trend = query.runQuery(s, { type: "trend" }, v3.computePicture, v3.toMoney);
  assert("trend returns something", trend.trend !== undefined || trend.direction !== undefined);

  const bad = query.runQuery(s, { type: "nonsense" }, v3.computePicture, v3.toMoney);
  assert("bad query returns error", bad.error !== undefined);
}

console.log("\n=== 8. OPENAI LIVE TEST ===");
if (process.env.OPENAI_API_KEY && sysPrompt && v3) {
  const OpenAI = require("openai");
  const openai = new OpenAI();
  const state = v3.createFreshState();
  const prompt = sysPrompt.buildSystemPrompt(state);

  console.log("  Calling gpt-4o-mini with json_object mode...");
  openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "hi" },
    ],
  }).then(r => {
    const text = r.choices?.[0]?.message?.content ?? "";
    assert("OpenAI returns content", text.length > 0);
    let parsed;
    try { parsed = JSON.parse(text); assert("Response is valid JSON", true); }
    catch { assert("Response is valid JSON", false, "Got: " + text.slice(0, 100)); parsed = null; }
    if (parsed) {
      assert("Response has 'message' field", typeof parsed.message === "string", "Got keys: " + Object.keys(parsed).join(","));
      assert("Response has 'actions' array", Array.isArray(parsed.actions), "Got: " + typeof parsed.actions);
      assert("Response has 'verify' field", typeof parsed.verify === "boolean", "Got: " + typeof parsed.verify);
      if (parsed.actions && parsed.actions[0]) {
        assert("First action has 'type'", typeof parsed.actions[0].type === "string");
        assert("First action has 'data'", typeof parsed.actions[0].data === "object" || parsed.actions[0].type === "none");
      }
    }
    console.log("\n  Raw response preview: " + text.slice(0, 200));
    printSummary();
  }).catch(e => {
    assert("OpenAI call succeeds", false, e.message);
    printSummary();
  });
} else {
  if (!process.env.OPENAI_API_KEY) console.log("  ⚠ OPENAI_API_KEY not set — skipping live test");
  printSummary();
}

function printSummary() {
  console.log("\n" + "=".repeat(40));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail === 0) console.log("✓ ALL TESTS PASSED — safe to deploy");
  else console.log("✗ FAILURES DETECTED — do NOT deploy");
  console.log("=".repeat(40) + "\n");
  process.exit(fail > 0 ? 1 : 0);
}
