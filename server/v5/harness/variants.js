"use strict";
// variants.js — generate paraphrases of a symptom and run them through
// the actual pipeline. Reports pass/fail per variant.
//
// Usage:
//   node server/v5/harness/variants.js bug-reports/<id>
//   node server/v5/harness/variants.js --inline "I make 5000/mo, rent 1400" --expect="record_income,add_bill"
//   node server/v5/harness/variants.js --inline "..." --expect="..." --count=10 --langs=en,ru
//
// A variant passes if the AI emits AT LEAST the expected intent kinds
// for that variant's user message. Stricter check (no extra intents) is
// available with --strict.

require("dotenv").config({ override: true });

const fs = require("fs");
const path = require("path");
const m = require("../model");
const { applyIntent } = require("../engine");
const { getBackend } = require("./ai-backend");
const { createMockChat } = require("./telegram-mock");
const { createMockPrisma } = require("./prisma-mock");
const bot = require("../bot");
const db = require("../db");

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

// generateVariants — call the AI to paraphrase the seed text into N
// distinct messages preserving the same intent set. We deliberately use
// a different model (gpt-4o or claude) than the bot uses, so it's
// adversarial rather than tautological.
async function generateVariants(seedText, count, langs) {
  const ai = getBackend();
  const sys = [
    "You are a paraphrasing tool. Given a user message that conveys 1-3 financial actions, produce variants that preserve the SAME meaning (same actions, same amounts) but vary surface form.",
    "Generate variants that are realistic for a real human texting a money bot:",
    "- different word order",
    "- different verbosity (terse / chatty / rambly)",
    "- voice-note style (run-on, ums, casual)",
    "- typos and abbreviations (k for thousand, &)",
    "- different framings (questions vs statements)",
    "- different supplied languages: " + langs.join(", "),
    "- never change the underlying numbers or actions",
    "",
    "Return STRICT JSON: { \"variants\": [\"text 1\", \"text 2\", ...] }",
    "Generate exactly " + count + " variants. Mix the languages roughly evenly across variants.",
  ].join("\n");
  const user = "Seed message: " + JSON.stringify(seedText);
  const raw = await ai([{ role: "system", content: sys }, { role: "user", content: user }]);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.variants)) {
    // Salvage: pull strings between quotes if we can.
    const arr = (raw.match(/"([^"]{4,200})"/g) || []).map(s => s.slice(1, -1));
    return arr.slice(0, count);
  }
  return parsed.variants.slice(0, count);
}

// runOne — execute a single variant text through bot pipeline. Returns
// { intentKinds: [...], rawAiOutputs: [...] }.
async function runOne(variantText, opts) {
  const prisma = createMockPrisma();
  const chat = createMockChat({ userId: 100001, language_code: opts.lang || "en" });
  const realAi = getBackend();
  const rawCaptured = [];
  const aiCall = async (msgs) => {
    const raw = await realAi(msgs);
    rawCaptured.push(typeof raw === "string" ? raw : JSON.stringify(raw));
    return raw;
  };
  const aiOptions = { _aiCall: aiCall };

  const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
  let state = await db.loadState(prisma, u.id);
  if (opts.setup) {
    const today = m.today("UTC");
    let r = applyIntent(state, {
      kind: "setup_account",
      params: { balanceCents: opts.balance || 500000, payday: m.addDays(today, 30), payFrequency: "monthly" },
    });
    state = r.state;
    if (opts.lang) state.language = opts.lang;
    await db.saveState(prisma, u.id, state);
  }

  const ctx = chat.makeIncomingTextCtx(variantText);
  await bot.processText(prisma, ctx, chat.user.id, variantText, aiOptions);
  // Auto-tap any visible confirm button so we capture the applied intents.
  const last = chat.lastInlineButtons();
  if (last && last.buttons.length > 0) {
    const yes = last.buttons.find(b => /yes|log|сохран|да/i.test(b.text)) || last.buttons[0];
    chat.setCurrentEditTarget(last.messageId);
    const cbCtx = chat.makeIncomingCallbackCtx(yes, last.messageId);
    await bot.processCallbackData(prisma, cbCtx, chat.user.id, yes.callback_data);
  }

  state = await db.loadState(prisma, u.id);
  const events = state.events || [];
  // Skip the seed setup event when reporting intents.
  const intents = events.map(e => e.intent).filter(Boolean);
  const userIntents = intents.filter(i => i.kind !== "setup_account" || !opts.setup);
  return {
    intentKinds: userIntents.map(i => i.kind),
    intents: userIntents,
    rawAi: rawCaptured,
  };
}

function judgeOne(result, expected, strict) {
  const got = new Set(result.intentKinds);
  const exp = new Set(expected);
  const missing = [...exp].filter(k => !got.has(k));
  const extra  = [...got].filter(k => !exp.has(k));
  if (strict) return { pass: missing.length === 0 && extra.length === 0, missing, extra };
  return { pass: missing.length === 0, missing, extra };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let seedText, expected, lang, setup, balance, outDir;

  if (args.flags.inline) {
    seedText = args.flags.inline;
    expected = (args.flags.expect || "").split(",").map(s => s.trim()).filter(Boolean);
    lang = args.flags.lang || "en";
    setup = !!args.flags.setup;
    balance = args.flags.balance ? Number(args.flags.balance) : 500000;
    outDir = path.join(__dirname, "..", "..", "..", "bug-reports", "_tmp");
  } else {
    const dir = args.rest[0];
    if (!dir) {
      console.error("Usage: node variants.js <bug-reports/id>  OR  --inline=\"...\" --expect=\"kind1,kind2\"");
      process.exit(2);
    }
    const reproPath = path.join(process.cwd(), dir, "02-repro-output.json");
    if (!fs.existsSync(reproPath)) {
      console.error("Missing repro output at " + reproPath);
      process.exit(2);
    }
    const repro = JSON.parse(fs.readFileSync(reproPath, "utf8"));
    seedText = repro.symptom;
    // Pull expected from a per-bug expected.json if present, else from
    // the repro's emitted intents (which is the post-fix expected set).
    const expectedPath = path.join(process.cwd(), dir, "expected.json");
    if (fs.existsSync(expectedPath)) {
      expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")).intents || [];
    } else {
      expected = repro.emittedIntents.map(i => i.kind).filter(k => k !== "setup_account");
    }
    lang = repro.lang || "en";
    setup = !!repro.setupSeeded;
    balance = 500000;
    outDir = path.join(process.cwd(), dir);
  }

  const count = Number(args.flags.count || 10);
  const langs = (args.flags.langs || lang).split(",");
  const strict = !!args.flags.strict;

  console.log("=== VARIANT EXPLOSION ===");
  console.log("seed: " + seedText);
  console.log("expected intents: " + expected.join(", "));
  console.log("count: " + count + "  langs: " + langs.join(",") + "  strict: " + strict);
  console.log("");

  console.log("Generating " + count + " variants...");
  const variants = await generateVariants(seedText, count, langs);
  console.log("Generated " + variants.length + ".\n");

  const results = [];
  let pass = 0;
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    process.stdout.write("[" + (i + 1) + "/" + variants.length + "] " + v.slice(0, 60) + (v.length > 60 ? "..." : "") + " ");
    let r;
    try {
      r = await runOne(v, { lang, setup, balance });
    } catch (e) {
      console.log("CRASH " + e.message);
      results.push({ variant: v, crashed: true, error: e.message });
      continue;
    }
    const j = judgeOne(r, expected, strict);
    if (j.pass) { pass++; console.log("PASS [" + r.intentKinds.join(",") + "]"); }
    else        { console.log("FAIL missing=[" + j.missing.join(",") + "] got=[" + r.intentKinds.join(",") + "]"); }
    results.push({ variant: v, intents: r.intentKinds, missing: j.missing, extra: j.extra, pass: j.pass });
  }

  const passRate = results.filter(r => r.pass).length + "/" + results.length;
  console.log("\n=== SUMMARY ===");
  console.log("pass rate: " + passRate);

  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, "03-variants.log");
  fs.writeFileSync(logPath, JSON.stringify({
    seed: seedText, expected, count: variants.length,
    passed: results.filter(r => r.pass).length,
    results,
    timestamp: new Date().toISOString(),
  }, null, 2), "utf8");
  console.log("→ " + logPath);
  process.exit(results.every(r => r.pass) ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
