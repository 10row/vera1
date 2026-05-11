"use strict";
// v5/index.js — Express + Telegram bot entry point.

require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const prisma = require("../db/client");
const m = require("./model");
const { compute, simulateSpend, heroLine, projectPaceImpact } = require("./view");
const { applyIntent } = require("./engine");
const { validateIntent } = require("./validator");
const { M } = require("./messages");
const db = require("./db");
const { bot, attach } = require("./bot");

// Mirror of bot.js translateErr — translate engine error codes for
// the API response to the Mini App. Mini App renders error strings
// directly to the user.
function translateErrLocal(e, lang) {
  if (!e) return "";
  if (e.code) {
    const t = M(lang, e.code, e.params);
    if (t && t !== e.code) return t;
  }
  return e.message || String(e);
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "16kb" }));

// ── INITDATA VALIDATION ──────────────────────────
function getBotToken() { return (process.env.BOT_TOKEN || "").trim(); }

function validateInitData(initData) {
  const token = getBotToken();
  if (!initData || !token) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const checkHash = crypto.createHmac("sha256", secretKey).update(dcs).digest("hex");
    if (checkHash !== hash) return null;
    const authDate = parseInt(params.get("auth_date") || "0");
    if (Date.now() / 1000 - authDate > 7 * 24 * 60 * 60) return null;
    const user = params.get("user");
    return user ? JSON.parse(user) : null;
  } catch { return null; }
}

function requireTelegramAuth(req, res, next) {
  const sid = req.params.sid;
  const initData = req.headers["x-telegram-init-data"];
  if (initData) {
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: "Invalid Telegram auth" });
    if (sid && sid.startsWith("tg_")) {
      if (String(user.id) !== sid.slice(3)) return res.status(403).json({ error: "User mismatch" });
    } else {
      req.params.sid = "tg_" + String(user.id);
    }
    req.tgUser = user;
    return next();
  }
  if (sid && sid.startsWith("tg_")) return res.status(401).json({ error: "Missing Telegram auth" });
  next();
}

// ── STATIC ────────────────────────────────────────
app.use("/miniapp", express.static(path.join(__dirname, "../../miniapp")));
app.get("/", (req, res) => res.redirect("/miniapp/"));
app.get("/health", (req, res) => res.json({ status: "ok", schema: "v5", ts: new Date().toISOString() }));

// ── DIAGNOSTIC ────────────────────────────────────
function whoami(req, res) {
  const initData = req.headers["x-telegram-init-data"];
  const token = getBotToken();
  if (!initData) return res.json({ ok: false, why: "no initData" });
  const user = validateInitData(initData);
  res.json({ ok: !!user, user: user || null, hasToken: !!token });
}
app.get("/api/v5/whoami", whoami);
app.get("/api/v4/whoami", whoami);

// ── MINI APP COMPATIBILITY (v4 endpoints, v5 backend) ─────────
// The Mini App was built against v4's view shape. v5 has fewer concepts
// (bills only, no envelopes/budgets/goals split). We translate v5 state
// into the v4-compatible view shape so the Mini App keeps rendering.
function v5ToV4View(state) {
  const view = compute(state); // v5 view
  const sym = state.currencySymbol || "$";
  const todayStr = m.today(state.timezone || "UTC");

  if (!view.setup) return { setup: false, language: state.language || "en", currency: state.currency || "USD", currencySymbol: sym };

  // Map v5 bills → v4 envelopes shape (kind: "bill").
  // cycleStatus: "this" if dueDate is on/before payday (engine reserves
  // money for it now), "next" if dueDate is past payday (the next
  // paycheck will cover it). Surfacing this lets the Mini App show a
  // quiet "next cycle" chip on bill cards — closes the visibility gap
  // where the engine's reservation math was implicit.
  const envelopes = Object.values(state.bills || {}).map(b => {
    const beforePayday = state.payday ? m.daysBetween(b.dueDate, state.payday) >= 0 : true;
    const cycleStatus = (b.paidThisCycle || beforePayday) ? "this" : "next";
    // Foreign-currency display string when the bill was created with a
    // non-base currency. Mini app + chat both consume amountFormatted —
    // this preserves the conversion phrase ("€200 ≈ $216") through.
    const hasForeign = b.originalCurrency && Number.isFinite(b.originalAmount) && b.originalAmount > 0;
    let amountFormatted = m.toMoney(b.amountCents, sym);
    if (hasForeign) {
      try {
        const ccy = require("./currency");
        const fromSubunits = ccy.spokenToSubunits(b.originalAmount, b.originalCurrency);
        amountFormatted = ccy.fmt(fromSubunits, b.originalCurrency) + " ≈ " + m.toMoney(b.amountCents, sym);
      } catch { /* fall back to base-only */ }
    }
    return {
      key: m.billKey(b.name),
      name: b.name,
      kind: "bill",
      amountCents: b.amountCents,
      amountFormatted,
      // Native fields for the mini app to format independently if needed.
      originalAmount: hasForeign ? b.originalAmount : undefined,
      originalCurrency: hasForeign ? b.originalCurrency : undefined,
      spentCents: 0,
      spentFormatted: m.toMoney(0, sym),
      dueDate: b.dueDate,
      daysUntilDue: m.daysBetween(todayStr, b.dueDate),
      recurrence: b.recurrence,
      paidThisCycle: !!b.paidThisCycle,
      isDue: m.daysBetween(todayStr, b.dueDate) <= 1 && !b.paidThisCycle,
      cycleStatus,
      createdAt: b.createdAt,
    };
  });

  // Bills totals by cycle — drives the bills section subtitle so the
  // user can SEE what's reserved vs what slips to next cycle. Before
  // this, the engine's bill reservation math was invisible (user saw
  // "$166/day for 23 days" but couldn't tell that bills were already
  // carved out, nor which bills were even in this cycle's math).
  let billsThisCycleCents = 0;
  let billsNextCycleCents = 0;
  for (const e of envelopes) {
    if (e.paidThisCycle) continue;
    if (e.cycleStatus === "this") billsThisCycleCents += e.amountCents || 0;
    else billsNextCycleCents += e.amountCents || 0;
  }

  // Today's remaining = dailyPace - what they've spent today.
  const todayRem = Math.max(0, view.dailyPaceCents - view.todaySpentCents);

  // Variance = today's spend vs today's pace.
  // Positive = under pace (saved). Negative = over pace.
  // Used by hero variance chip (informational only — does NOT change pace).
  const varianceCents = view.dailyPaceCents > 0
    ? (view.dailyPaceCents - view.todaySpentCents)
    : 0;

  // Pace-impact line — show how today's variance (over/under) ripples
  // across the rest of the cycle. See projectPaceImpact() in view.js
  // for the math + the bug-class history (was: day-decrement; now:
  // variance distribution). Returns 0 delta when there's no signal
  // yet (no spend today) OR when user is in over-state.
  const { tomorrowPaceCents, paceDeltaCents } = projectPaceImpact(view);

  return {
    setup: true,
    state: view.status,
    language: state.language || "en",
    currency: state.currency || "USD",
    currencySymbol: sym,
    timezone: state.timezone || "UTC",
    payday: state.payday,
    payFrequency: state.payFrequency,
    daysToPayday: view.daysToPayday,

    balanceCents: view.balanceCents,
    balanceFormatted: view.balanceFormatted,
    balanceShort: m.toShort(view.balanceCents, sym),
    obligatedCents: view.obligatedCents,
    obligatedFormatted: view.obligatedFormatted,
    disposableCents: view.disposableCents,
    disposableFormatted: view.disposableFormatted,
    disposableShort: m.toShort(view.disposableCents, sym),
    deficitCents: view.deficitCents,
    deficitFormatted: view.deficitFormatted,
    dailyPaceCents: view.dailyPaceCents,
    dailyPaceFormatted: view.dailyPaceFormatted,
    dailyPaceShort: m.toShort(view.dailyPaceCents, sym),

    todaySpentCents: view.todaySpentCents,
    todaySpentFormatted: view.todaySpentFormatted,
    weekSpentCents: view.weekSpentCents,
    weekSpentFormatted: view.weekSpentFormatted,
    todayRemainingCents: todayRem,
    todayRemainingFormatted: m.toMoney(todayRem, sym),

    // Hero variance chip — under/over today's pace.
    varianceCents,
    varianceShort: m.toShort(Math.abs(varianceCents), sym),

    // Projected next-day pace and the per-day delta from today's
    // frozen pace. Drives the "$X/day less/more rest of cycle" line
    // under the variance chip — Option A from the design discussion.
    //
    // Math: balance has ALREADY been decremented by today's spends
    // (record_spend mutates balance immediately). So tomorrow's
    // disposable === current disposable, and tomorrow's pace =
    // floor(disposable / (daysToPayday − 1)). Compared to today's
    // FROZEN pace (which reflects the start-of-day disposable), the
    // delta tells the user what today's variance costs (over) or
    // saves (under) per day for the rest of the cycle.
    //
    // Skip when daysToPayday ≤ 1 (tomorrow is payday — projection is
    // meaningless) or when the user is already in over-state (pace
    // is capped at 0; delta math is degenerate). In those cases
    // paceDeltaCents = 0 and the Mini App hides the line.
    tomorrowPaceCents,
    tomorrowPaceShort: m.toShort(tomorrowPaceCents, sym),
    paceDeltaCents,
    paceDeltaShort: m.toShort(Math.abs(paceDeltaCents), sym),

    // Bills protected vs next-cycle (visibility into engine math).
    billsThisCycleCents,
    billsThisCycleShort: m.toShort(billsThisCycleCents, sym),
    billsNextCycleCents,
    billsNextCycleShort: m.toShort(billsNextCycleCents, sym),

    envelopes,
    dueNow: view.dueNow.map(d => ({ key: d.key, name: d.name, amountFormatted: d.amountFormatted, dueDate: d.dueDate, daysUntilDue: d.daysUntilDue })),
    upcoming: view.upcoming.map(d => ({ key: d.key, name: d.name, amountFormatted: d.amountFormatted, dueDate: d.dueDate, daysUntilDue: d.daysUntilDue })),
    statusWord: view.status,

    invariantOk: true,
  };
}

// buildHeatmap — last-30-days daily spend totals, the shape Mini App
// expects. Each cell: { date: "YYYY-MM-DD", spentCents: N }.
function buildHeatmap(state) {
  const tz = state.timezone || "UTC";
  const today = m.today(tz);
  const paceHist = (state && state.paceHistory) || {};
  const currentPace = state && state.dailyPaceCents || 0;
  const out = [];
  // Walk back 29 days (so we get 30 cells ending today).
  // Two bug fixes:
  //   1. The kind value is "spend" (set by engine record_spend), NOT
  //      "record_spend". Old check used the wrong string so the heatmap
  //      never showed any data — long-standing bug.
  //   2. Skip soft-deleted txs (deletedAt set) — same reason as view.
  //
  // PER-DAY PACE: each cell now carries the pace THAT DAY had (from
  // state.paceHistory, written by engine.refreshPace at cycle events
  // + day rollover). Falls back to today's pace if no snapshot exists
  // (e.g. cells from before this feature shipped). Heatmap color
  // compares spend-vs-that-day's-pace, not spend-vs-today's-pace —
  // fixes the "very over but shows orange" misclassification.
  for (let offset = 29; offset >= 0; offset--) {
    const date = m.addDays(today, -offset);
    let cents = 0;
    for (const t of state.transactions || []) {
      if (t.deletedAt) continue;
      // Discretionary spend only — exclude bill payments (obligations).
      if (t.kind !== "spend") continue;
      if (t.date === date) cents += Math.abs(t.amountCents || 0);
    }
    // Per-day pace lookup with two-tier fallback:
    //   1. Exact paceHistory entry for THIS date (set when engine
    //      refreshed pace on this day)
    //   2. Most-recent prior paceHistory entry (covers days where no
    //      cycle event fired — pace was stable through that day)
    //   3. Current pace (covers all dates before paceHistory existed)
    let paceForDay = paceHist[date];
    if (paceForDay == null) {
      // Walk back through paceHistory for the most-recent prior entry.
      const earlierKeys = Object.keys(paceHist).filter(k => k < date).sort();
      if (earlierKeys.length) paceForDay = paceHist[earlierKeys[earlierKeys.length - 1]];
    }
    if (paceForDay == null) paceForDay = currentPace;
    out.push({ date, spentCents: cents, paceCents: paceForDay });
  }
  return out;
}

// recentTransactionsForApp — ALL non-deleted spends/incomes formatted
// for the feed. Skips soft-deleted (journaling), exposes ALL graph
// fields so the Mini App detail modal can show vendor/category/tags/
// context/foreign-currency without re-fetching.
//
// CAP HISTORY: previously sliced to 50, which broke two things:
//   1. History feed cut off at 50 (user couldn't see older spends)
//   2. Heatmap day-tap showed empty for days >5 ago when the user
//      was active (50 most-recent didn't span 30 days of dense use)
//
// Now: send everything non-deleted. Safety cap at 2000 (covers ~1 year
// at 5 spends/day average — bounded payload). If a user exceeds that,
// we'll add pagination — but it's not a near-term constraint.
const MAX_TXS_IN_FEED = 2000;
function recentTransactionsForApp(state) {
  const txs = state.transactions || [];
  return txs.filter(t => !t.deletedAt).slice(-MAX_TXS_IN_FEED).reverse().map(t => ({
    id: t.id,
    kind: t.kind,
    amountCents: t.amountCents,
    note: t.note || "",
    envelopeKey: t.billKey || null,
    date: t.date,
    ts: t.ts,
    // Graph fields (any may be null for older or AI-omitted txs).
    vendor: t.vendor || null,
    category: t.category || null,
    tags: t.tags || null,
    context: t.context || null,
    // Foreign-currency display fields.
    originalAmount: t.originalAmount || null,
    originalCurrency: t.originalCurrency || null,
  }));
}

// Mini App GET /api/v4/view/:sid — returns { view, recentTransactions, heatmap }.
// Mini App reads d.view, d.recentTransactions, d.heatmap. Keep that shape.
app.get("/api/v4/view/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const view = v5ToV4View(state);
    res.json({
      view,
      recentTransactions: recentTransactionsForApp(state),
      heatmap: buildHeatmap(state),
    });
  } catch (e) {
    console.error("[v5 v4-view alias]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// Mini App POST /api/v4/action/:sid — body shape: { intent: { kind, params } }.
// Supports the intents Mini App still triggers (pay_bill via "mark paid").
// Anything else returns { ok: false, error: "..." }. Mini App expects
// { ok, view } on success.
app.post("/api/v4/action/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const intent = req.body && req.body.intent;
    if (!intent || !intent.kind) return res.status(400).json({ ok: false, error: "Missing intent" });
    const u = await db.resolveUser(prisma, req.params.sid);
    let result = null;
    await db.withUserLock(u.id, async () => {
      const state = await db.loadState(prisma, u.id);
      // Translate v4 pay_bill → v5 record_spend on the matching bill.
      let translated = intent;
      if (intent.kind === "pay_bill" && intent.params && intent.params.name) {
        const targetKey = m.billKey(intent.params.name);
        const bill = state.bills && state.bills[targetKey];
        if (!bill) { result = { ok: false, error: "no such bill" }; return; }
        translated = {
          kind: "record_spend",
          params: {
            amountCents: bill.amountCents,
            note: bill.name,
            billKey: targetKey,
          },
        };
      }
      const lang = state.language || "en";
      const v = validateIntent(state, translated, m.today(state.timezone || "UTC"), lang);
      if (!v.ok) { result = { ok: false, error: v.reason }; return; }
      try {
        const r = applyIntent(state, translated);
        await db.saveState(prisma, u.id, r.state);
        result = {
          ok: true,
          view: v5ToV4View(r.state),
          recentTransactions: recentTransactionsForApp(r.state),
          heatmap: buildHeatmap(r.state),
        };
      } catch (e) {
        result = { ok: false, error: translateErrLocal(e, lang) };
      }
    });
    res.json(result);
  } catch (e) {
    console.error("[v5 v4-action alias]", e);
    res.status(500).json({ ok: false, error: "Internal" });
  }
});

// Mini App locale endpoint — uses v4's locale files (still in repo with
// the keys the Mini App expects).
const _v4Locales = require("../v4/locales");
app.get("/api/v4/locale", (req, res) => {
  try {
    const lang = (req.query.lang || "en").toString();
    const base = (_v4Locales.normalizeLang ? _v4Locales.normalizeLang(lang) : "en");
    const strings = (_v4Locales.LOCALES && _v4Locales.LOCALES[base]) || (_v4Locales.LOCALES && _v4Locales.LOCALES.en) || {};
    res.json({ lang: base, strings });
  } catch (e) {
    console.error("[v5 locale alias]", e);
    res.json({ lang: "en", strings: {} });
  }
});

// ── MINI APP API ──────────────────────────────────
app.get("/api/v5/view/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const view = compute(state);
    res.json({ view, hero: heroLine(state, state.language) });
  } catch (e) {
    console.error("[v5 view]", e);
    res.status(500).json({ error: "Internal" });
  }
});

app.post("/api/v5/action/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const intent = req.body.intent;
    if (!intent || typeof intent.kind !== "string") return res.status(400).json({ error: "Invalid intent" });
    const u = await db.resolveUser(prisma, req.params.sid);
    let result;
    await db.withUserLock(u.id, async () => {
      const state = await db.loadState(prisma, u.id);
      const lang = state.language || "en";
      const verdict = validateIntent(state, intent, m.today(state.timezone || "UTC"), lang);
      if (!verdict.ok) {
        // Clarify (soft reject) and hard reject both surface here for
        // the Mini App. Mini App renders whichever is set as the error
        // message — a clarify question reads naturally as an error in
        // the in-app confirm flow ("By when?" displayed inline).
        const msg = verdict.clarify ? verdict.clarify.question : verdict.reason;
        result = { ok: false, error: msg, clarify: verdict.clarify || undefined };
        return;
      }
      try {
        const r = applyIntent(state, intent);
        await db.saveState(prisma, u.id, r.state);
        result = { ok: true, view: compute(r.state) };
      } catch (e) {
        result = { ok: false, error: translateErrLocal(e, lang) };
      }
    });
    res.json(result);
  } catch (e) {
    console.error("[v5 action]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// /api/v5/parse — Mini App's in-app input. Takes raw user text, runs
// the SAME pipeline as a Telegram message would, returns the proposal
// (do/talk/decision) so the Mini App can render its own confirm card.
// This is the standalone-app input primitive: no chat hop required.
app.post("/api/v5/parse/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const text = String(req.body && req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Need text." });
    if (text.length > 2000) return res.status(400).json({ error: "Too long." });
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const { processMessage } = require("./pipeline");
    const result = await processMessage(state, text, [], { _debugUserId: u.telegramId || u.id });
    // Pass through whatever the pipeline returns. Mini App's InputModal
    // knows how to render each kind (do, do_batch, talk, decision).
    res.json(result);
  } catch (e) {
    console.error("[v5 parse]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// /api/v5/parse-photo — receipt photo from the mini app's inline
// camera button. Body: { dataUrl: "data:image/jpeg;base64,..." }
// (base64 keeps things JSON-only, no multipart deps). Returns the same
// shape as /api/v5/parse: { kind, intent, ... } so the InputModal
// renders the same confirm card whether the source was text or photo.
//
// Uses a per-route 8 MB body limit (above default 16 KB) because
// photos are large. Stripe-style: parse-only — apply happens via
// /api/v5/apply after user confirms.
const _parsePhotoBodyParser = express.json({ limit: "8mb" });
app.post("/api/v5/parse-photo/:sid", _parsePhotoBodyParser, requireTelegramAuth, async (req, res) => {
  try {
    const dataUrl = String(req.body && req.body.dataUrl || "");
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "Need a base64 image dataUrl." });
    }
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) return res.status(400).json({ error: "Malformed dataUrl." });
    const b64 = dataUrl.slice(commaIdx + 1);
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 1024 || buf.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: "Photo too small or too large." });
    }

    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    if (!state.setup) return res.status(400).json({ error: "Set up first." });

    const vision = require("./ai-vision");
    const r = await vision.extractFromReceipt(buf, Object.assign({}, state, { id: u.telegramId || u.id }));
    if (!r.ok) return res.json({ kind: "talk", message: r.reason || "Couldn't read the photo." });

    // Run the SAME pipeline post-AI steps (currency conversion, validation,
    // commitment-shape detection) so the photo flow merges with the text
    // flow before reaching the user's confirm card. Pipeline expects a
    // proposal-shape from the AI; synthesize one with the vision intent.
    const { processMessage } = require("./pipeline");
    // Use a synthetic user message so the pipeline's backdate-strip and
    // commitment-marker scanners have something neutral to operate on
    // (receipts don't carry English phrasing — they carry items + amounts).
    const syntheticMsg = (r.intent.params && r.intent.params.note) || "receipt photo";
    const result = await processMessage(state, syntheticMsg, [], {
      _debugUserId: u.telegramId || u.id,
      _aiCall: async () => JSON.stringify({
        mode: "do",
        message: "From receipt: " + (r.intent.params.vendor || r.intent.params.note || ""),
        intent: r.intent,
      }),
    });
    res.json(result);
  } catch (e) {
    console.error("[v5 parse-photo]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// /api/v5/apply — apply a confirmed intent (or array of intents) from
// the Mini App. Same validate+apply path as the Telegram confirm-yes
// callback, just exposed via HTTP. Multi-intent batches handled.
app.post("/api/v5/apply/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const intent = req.body && req.body.intent;
    const intents = req.body && req.body.intents;
    const list = Array.isArray(intents) && intents.length > 0 ? intents : (intent ? [intent] : []);
    if (list.length === 0) return res.status(400).json({ error: "No intent provided." });
    const u = await db.resolveUser(prisma, req.params.sid);
    let result;
    await db.withUserLock(u.id, async () => {
      let state = await db.loadState(prisma, u.id);
      const lang = state.language || "en";
      const todayStr = m.today(state.timezone || "UTC");
      const applied = [];
      const failed = [];
      for (const it of list) {
        const verdict = validateIntent(state, it, todayStr, lang);
        if (!verdict.ok) {
          const reason = verdict.clarify ? verdict.clarify.question : verdict.reason;
          failed.push({ intent: it, reason });
          continue;
        }
        try {
          const r = applyIntent(state, it);
          state = r.state;
          applied.push(it);
        } catch (e) {
          failed.push({ intent: it, reason: translateErrLocal(e, lang) });
        }
      }
      if (applied.length > 0) await db.saveState(prisma, u.id, state);
      result = {
        ok: applied.length > 0,
        applied: applied.length,
        failed: failed.length ? failed.map(f => f.reason) : undefined,
        view: compute(state),
      };
    });
    res.json(result);
  } catch (e) {
    console.error("[v5 apply]", e);
    res.status(500).json({ error: "Internal" });
  }
});

app.get("/api/v5/simulate/:sid", requireTelegramAuth, async (req, res) => {
  try {
    const amt = Math.round(Number(req.query.amountCents));
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "amountCents required" });
    const u = await db.resolveUser(prisma, req.params.sid);
    const state = await db.loadState(prisma, u.id);
    const sim = simulateSpend(state, amt);
    res.json({ simulate: sim });
  } catch (e) {
    console.error("[v5 simulate]", e);
    res.status(500).json({ error: "Internal" });
  }
});

// ── TELEGRAM ──────────────────────────────────────
attach(prisma);

app.post("/telegram/webhook", async (req, res) => {
  if (!bot) return res.sendStatus(200);
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("[v5 webhook]", err);
    res.sendStatus(200);
  }
});

// ── DB MIGRATE ON START ──────────────────────────
function migrateDb() {
  try {
    execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
    console.log("[v5] prisma db push OK");
  } catch {
    console.error("[v5] prisma db push failed (continuing)");
  }
}

// ── CURRENCY RATES — daily fetch + cache hydrate ──
// Free public service (Frankfurter, ECB-backed). Cron at 6am UTC
// fetches today's rates; bot startup hydrates the in-memory cache
// from the DB. Conversion (currency.convertSubunits) consults the
// cache by date for historical accuracy on backdated spends.
async function ensureRatesFresh() {
  const fetcher = require("./rate-fetcher");
  const currency = require("./currency");
  try {
    // First, hydrate the cache from whatever's already in the DB.
    const cached = await currency.hydrateRateCache(prisma, 90);
    console.log("[rates] cache hydrated:", cached, "rows");

    // If cache is empty or doesn't have today's rates, fetch fresh.
    // Idempotent — upsert means re-fetching the same day is safe.
    const today = m.today("UTC");
    const todayCount = await prisma.currencyRate.count({ where: { date: today } });
    if (todayCount === 0) {
      console.log("[rates] no rates for", today, "— fetching from Frankfurter");
      try {
        await fetcher.fetchToday(prisma);
        await currency.hydrateRateCache(prisma, 90);
        console.log("[rates] fetched + re-hydrated");
      } catch (e) {
        console.warn("[rates] fetchToday failed:", e.message);
      }
    }

    // If cache is still very sparse (first deploy with empty table),
    // backfill 30 days so backdated spends get historical rates.
    const totalCount = await prisma.currencyRate.count();
    if (totalCount < 100) {
      console.log("[rates] sparse table (" + totalCount + " rows) — backfilling 30 days");
      try {
        await fetcher.backfill(prisma, 30);
        await currency.hydrateRateCache(prisma, 90);
      } catch (e) {
        console.warn("[rates] backfill failed:", e.message);
      }
    }
  } catch (e) {
    console.warn("[rates] ensureRatesFresh failed (continuing with hardcoded):", e.message);
  }
}

function startRateCron() {
  const fetcher = require("./rate-fetcher");
  const currency = require("./currency");
  // Every 24 hours, fetch latest + re-hydrate cache. Frankfurter
  // publishes EU-time, so a 6am UTC fetch catches the day's update.
  // We use a simple setInterval — accuracy is daily-ish, not minute-
  // precise, which is fine for FX rates.
  const ONE_DAY = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await fetcher.fetchToday(prisma);
      await currency.hydrateRateCache(prisma, 90);
      console.log("[rates] cron: fetched + re-hydrated");
    } catch (e) {
      console.warn("[rates] cron fetch failed:", e.message);
    }
  }, ONE_DAY).unref(); // unref so it doesn't block process exit in tests
  console.log("[rates] cron scheduled — every 24h");
}

// ── STARTUP ───────────────────────────────────────
async function start() {
  if (process.env.SKIP_MIGRATE !== "1") migrateDb();

  try { await prisma.$connect(); console.log("[v5] db connected"); }
  catch (err) { console.error("[v5] db:", err.message); process.exit(1); }

  // Currency-rate cache: hydrate from DB + ensure today's rate.
  //
  // CRITICAL: fire-and-forget. Do NOT await this. On first deploy
  // (or empty rate table) ensureRatesFresh runs a 30-day backfill =
  // 30 sequential HTTP calls ≈ 5-10s of blocking work. If we await,
  // Express doesn't start listening until that finishes — every cold-
  // start (Railway container wake) becomes a ~10s delay before the
  // bot can answer the user's first tap. (Real bug: user reported
  // confirm feeling slow, traced to this exact pattern.)
  //
  // Backgrounding is safe: convertSubunits already falls back to the
  // hardcoded RATES_TO_USD table when the cache hasn't loaded yet,
  // so worst case the first few requests get hardcoded rates (same
  // behavior as before this feature shipped). By the time the user
  // is on their second action, the cache is hot.
  ensureRatesFresh().catch(e => {
    console.warn("[rates] background init failed (continuing with hardcoded):", e.message);
  });
  startRateCron();

  app.listen(PORT, async () => {
    console.log("SpendYes v5 listening on :" + PORT);

    if (!bot || !process.env.BOT_TOKEN) {
      console.warn("[v5] BOT_TOKEN missing — bot disabled");
      return;
    }

    try {
      await bot.init();
      console.log("[v5] bot:", bot.botInfo && bot.botInfo.username);
    } catch (err) {
      console.error("[v5] bot init:", err.message);
      return;
    }

    // Webhook URL — Telegram must point at /telegram/webhook on our host.
    if (process.env.WEBHOOK_URL) {
      try {
        const base = process.env.WEBHOOK_URL.replace(/\/$/, "");
        const target = /\/telegram\/webhook$/.test(base) ? base : base + "/telegram/webhook";
        await bot.api.setWebhook(target);
        console.log("[v5] webhook:", target);
      } catch (err) {
        console.error("[v5] webhook set:", err.message);
      }
    } else {
      // Polling fallback for local dev / Railway misconfiguration.
      bot.start({ onStart: () => console.log("[v5] bot polling…") });
    }

    // Persistent ≡ Dashboard menu button → opens Mini App.
    if (process.env.MINIAPP_URL && /^https:\/\//.test(process.env.MINIAPP_URL)) {
      try {
        await bot.api.setChatMenuButton({
          menu_button: {
            type: "web_app",
            text: "Dashboard",
            web_app: { url: process.env.MINIAPP_URL },
          },
        });
        console.log("[v5] menu button →", process.env.MINIAPP_URL);
      } catch (err) {
        console.error("[v5] menu button:", err.message);
      }
    }

    // Slash-command menu shown in Telegram's UI.
    try {
      await bot.api.setMyCommands([
        { command: "start", description: "Start or check status" },
        { command: "today", description: "Today's hero line" },
        { command: "help",  description: "What I can do — examples" },
        { command: "undo",  description: "Undo last action" },
        { command: "app",   description: "Open the dashboard" },
        { command: "reset", description: "Wipe everything and start over" },
      ]);
    } catch (err) {
      console.error("[v5] setMyCommands:", err.message);
    }
  });
}

start();
