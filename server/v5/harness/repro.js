"use strict";
// repro.js — reproduce a bug from a free-text symptom.
//
// Usage:
//   node server/v5/harness/repro.js "I have $5000, paid 15th, rent 1400, save $200/mo for trip"
//   node server/v5/harness/repro.js --lang=ru --setup "купил кофе за 200 рублей"
//   node server/v5/harness/repro.js --setup --balance=500000 --bills='[{"name":"Rent","amountCents":140000,"dueDate":"2026-05-01"}]' "spent 50 on lunch"
//
// Routes the message through the actual v5 pipeline (real AI, real bot
// logic, mock chat/prisma). Outputs:
//   - transcript on stdout
//   - JSON file at bug-reports/<id-or-tmp>/02-repro-output.json
//   - HTML transcript at bug-reports/<id-or-tmp>/02-repro-transcript.html

require("dotenv").config({ override: true });

const fs = require("fs");
const path = require("path");
const { runScenario } = require("./driver");
const { renderTranscript } = require("./telegram-mock");
const m = require("../model");
const { applyIntent } = require("../engine");

function parseArgs(argv) {
  const out = { flags: {}, text: "" };
  const rest = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else out.flags[a.slice(2)] = true;
    } else {
      rest.push(a);
    }
  }
  out.text = rest.join(" ").trim();
  return out;
}

function buildSeedScenario(args) {
  const setup = !!args.flags.setup;
  const lang = args.flags.lang || "en";
  const balance = args.flags.balance ? Number(args.flags.balance) : 500000;
  const bills = args.flags.bills ? JSON.parse(args.flags.bills) : [];

  const steps = [];
  // Optional pre-setup so post-setup paths can be exercised directly.
  if (setup) {
    // Use the deterministic seed: directly invoke setup_account intent
    // via a synthesized scenario step that runs before the symptom.
    steps.push({ type: "_seed", _seed: { balance, lang, bills } });
  }
  steps.push({ type: "text", text: args.text });
  // Auto-tap "yes, all" or "yes" if a confirm card appears, so we can see
  // the full lifecycle (apply + final state).
  steps.push({ type: "tap", match: /yes|log it|сохранить|да/i });

  return {
    name: "repro",
    user: { language_code: lang },
    steps,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text) {
    console.error("Usage: node server/v5/harness/repro.js [--setup] [--lang=en|ru] [--balance=N] [--bills=JSON] \"<symptom text>\"");
    process.exit(2);
  }

  // We extend the driver via a custom seed step. The simplest path: pre-seed
  // the prisma mock with a setup state before driver runs. We hook in by
  // creating our own driver wrapper that handles _seed.
  const scenario = buildSeedScenario(args);
  const result = await runWithSeed(scenario);

  const targetDir = args.flags.id
    ? path.join(__dirname, "..", "..", "..", "bug-reports", args.flags.id)
    : path.join(__dirname, "..", "..", "..", "bug-reports", "_tmp");
  fs.mkdirSync(targetDir, { recursive: true });

  // Console output: human transcript.
  console.log("\n=== REPRODUCER ===");
  console.log("symptom: " + args.text);
  console.log("lang: " + (args.flags.lang || "en") + "  setup-seeded: " + !!args.flags.setup);
  console.log("\n--- TRANSCRIPT ---");
  console.log(renderTranscript(result.chat));

  // Diagnostic line: did the bot emit do/do_batch? what intents?
  console.log("\n--- DIAGNOSTIC ---");
  console.log("intents emitted: " + JSON.stringify(result.emittedIntents, null, 2));
  console.log("kinds: " + (result.emittedIntents.map(i => i.kind).join(", ") || "(none)"));
  console.log("final.setup: " + result.finalState.setup);
  console.log("final.balanceCents: " + result.finalState.balanceCents);
  console.log("final.bills: " + Object.keys(result.finalState.bills || {}).join(", "));

  // Raw AI outputs — the most diagnostic signal for "AI did nothing" bugs.
  const rawEntries = result.chat.transcript.filter(e => e.kind === "ai_raw");
  if (rawEntries.length > 0) {
    console.log("\n--- AI RAW OUTPUT ---");
    rawEntries.forEach((e, i) => console.log("[ai #" + (i + 1) + "] " + e.text));
  }

  // Write artifacts.
  const json = {
    symptom: args.text,
    lang: args.flags.lang || "en",
    setupSeeded: !!args.flags.setup,
    emittedIntents: result.emittedIntents,
    finalState: {
      setup: result.finalState.setup,
      balanceCents: result.finalState.balanceCents,
      bills: Object.keys(result.finalState.bills || {}),
      transactionCount: (result.finalState.transactions || []).length,
    },
    transcript: result.chat.transcript,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(targetDir, "02-repro-output.json"), JSON.stringify(json, null, 2), "utf8");
  fs.writeFileSync(path.join(targetDir, "02-repro-transcript.html"), renderHtml(result.chat, args.text), "utf8");
  console.log("\nartifacts → " + targetDir);
}

// runWithSeed — like runScenario but supports a _seed step that pre-sets state.
async function runWithSeed(scenario) {
  const { createMockChat } = require("./telegram-mock");
  const { createMockPrisma } = require("./prisma-mock");
  const { getBackend } = require("./ai-backend");
  const bot = require("../bot");
  const db = require("../db");

  const prisma = createMockPrisma();
  const chat = createMockChat({
    userId: (scenario.user && scenario.user.id) || 100001,
    language_code: (scenario.user && scenario.user.language_code) || "en",
  });

  const realAiCall = getBackend();
  // Wrap AI call to capture every raw response. We surface this as
  // "ai_raw" entries — the most diagnostic signal.
  const aiCall = async (msgs) => {
    const raw = await realAiCall(msgs);
    chat.transcript.push({ dir: "·", kind: "ai_raw", text: typeof raw === "string" ? raw : JSON.stringify(raw) });
    return raw;
  };
  const aiOptions = { _aiCall: aiCall };

  // Track intents emitted from confirm cards (single + batch) by inspecting
  // chat transcript: any reply containing structured intents shows up as a
  // describeIntent line. Easier: inspect state events directly after run.
  for (const step of scenario.steps) {
    if (step.type === "_seed") {
      // Pre-apply a setup_account intent so post-setup paths run.
      const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
      let state = await db.loadState(prisma, u.id);
      const today = m.today("UTC");
      const setupIntent = {
        kind: "setup_account",
        params: {
          balanceCents: step._seed.balance,
          payday: m.addDays(today, 30),
          payFrequency: "monthly",
        },
      };
      let r = applyIntent(state, setupIntent);
      state = r.state;
      state.language = step._seed.lang;
      // Optionally pre-add bills.
      for (const b of step._seed.bills || []) {
        const billIntent = {
          kind: "add_bill",
          params: { name: b.name, amountCents: b.amountCents, dueDate: b.dueDate, recurrence: b.recurrence || "monthly" },
        };
        r = applyIntent(state, billIntent);
        state = r.state;
      }
      await db.saveState(prisma, u.id, state);
      continue;
    }
    if (step.type === "text") {
      const ctx = chat.makeIncomingTextCtx(step.text);
      await bot.processText(prisma, ctx, chat.user.id, step.text, aiOptions);
    } else if (step.type === "tap") {
      const last = chat.lastInlineButtons();
      if (!last || last.buttons.length === 0) continue;
      let target = null;
      for (const b of last.buttons) {
        if (step.match instanceof RegExp ? step.match.test(b.text) : b.text.toLowerCase().includes(String(step.match || "").toLowerCase())) {
          target = b; break;
        }
      }
      if (!target) target = last.buttons[0];
      chat.setCurrentEditTarget(last.messageId);
      const ctx = chat.makeIncomingCallbackCtx(target, last.messageId);
      await bot.processCallbackData(prisma, ctx, chat.user.id, target.callback_data);
    }
  }

  // Final state + emitted intents.
  const u = await db.resolveUser(prisma, "tg_" + chat.user.id);
  const finalState = await db.loadState(prisma, u.id);
  // Walk events to extract intents emitted in this run (skip the seed setup).
  const allEvents = finalState.events || [];
  const seedKinds = new Set(["setup_account", "add_bill"]); // applied by seed
  const isSeedEvent = (e) => {
    // Heuristic: seed events were applied before the user's text step.
    // We mark them by checking createdAt vs scenario start; simpler: we
    // include all but tag setup_account+add_bill applied via seed as such.
    return e.intent && seedKinds.has(e.intent.kind) && e._seed === true;
  };
  // Easier: just return all events and let caller filter — for repro we
  // care most about post-seed intents.
  const emittedIntents = allEvents.filter(e => e.intent).map(e => e.intent);

  return { chat, finalState, emittedIntents };
}

function renderHtml(chat, symptom) {
  const escape = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const bubbles = chat.transcript.map(e => {
    if (e.dir === "→" && e.kind === "text") {
      return `<div class="row me"><div class="bubble me">${escape(e.text)}</div></div>`;
    }
    if (e.dir === "→" && e.kind === "tap") {
      return `<div class="row me-tap"><div class="tap">tapped: ${escape(e.text)}</div></div>`;
    }
    if (e.dir === "←" && (e.kind === "reply" || e.kind === "edit")) {
      const editTag = e.kind === "edit" ? `<span class="edit-tag">(edit)</span>` : "";
      const buttons = (e.inline_keyboard || []).map(row =>
        `<div class="btnrow">${row.map(b => `<span class="btn">${escape(b.text)}</span>`).join("")}</div>`
      ).join("");
      const text = escape(e.text || "").replace(/\n/g, "<br>");
      return `<div class="row bot"><div class="bubble bot">${editTag}${text}${buttons}</div></div>`;
    }
    return "";
  }).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Repro: ${escape(symptom)}</title>
<style>
body { background:#0F0F0F; color:#EFEFEF; font:14px/1.5 -apple-system,sans-serif; padding:20px; max-width:600px; margin:auto; }
.symptom { color:#888; font-size:12px; margin-bottom:20px; padding:10px; background:#1a1a1a; border-radius:8px; }
.row { display:flex; margin:8px 0; }
.row.me, .row.me-tap { justify-content:flex-end; }
.bubble { max-width:80%; padding:10px 14px; border-radius:14px; }
.bubble.me { background:#2B5278; color:#fff; }
.bubble.bot { background:#1f1f1f; color:#EFEFEF; }
.tap { font-size:11px; color:#888; padding:4px 10px; background:#222; border-radius:8px; }
.edit-tag { color:#888; font-size:11px; margin-right:6px; }
.btnrow { display:flex; gap:6px; margin-top:8px; }
.btn { background:#2B5278; padding:6px 12px; border-radius:6px; font-size:12px; }
</style>
<div class="symptom">SYMPTOM: ${escape(symptom)}</div>
${bubbles}
`;
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
