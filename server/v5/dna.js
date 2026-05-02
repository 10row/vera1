"use strict";
// v5/dna.js — User-DNA graph. PURE compute. NEVER mutates.
//
// THE IDEA: instead of feeding the AI raw transactions (expensive, noisy),
// derive a compact graph of NODES + EDGES representing the user's money
// shape. The AI sees the graph; it gets richer understanding for fewer
// tokens.
//
// NODES (kinds):
//   bill       — recurring obligation, e.g. "Rent". Has amount, dueDate, recurrence.
//   category   — clusters of related spend, e.g. "coffee", "groceries", "transport".
//                Auto-derived from transaction notes.
//   pattern    — temporal/behavioral observations, e.g. "spends most on Fridays".
//
// EDGES:
//   bill --depletes--> balance               (every cycle, subtracts amount)
//   category --drains-> balance              (per-week burn rate)
//   category --correlates-> day-of-week      (e.g. coffee weekdays, eating-out weekends)
//
// SCALING POLICY:
//   - Recompute the graph on demand from state.transactions + state.bills.
//   - Categories are clustered with simple keyword heuristics (no ML).
//     Notes "coffee", "starbucks", "latte" all → category "coffee".
//   - For transaction counts > 200, summarize categories with windowed
//     stats (last 30 / 90 days) instead of raw rollups.
//
// AI USAGE:
//   - The compact graph (renderForPrompt) is appended to the system prompt
//     so AI can answer "how much do I spend on coffee?", "is rent funded?",
//     "should I cut subscriptions?" without seeing raw txs.

const m = require("./model");

// Keyword → canonical category. Lowercase exact-substring match.
// Order matters: more-specific keywords first.
const CATEGORY_KEYWORDS = [
  ["coffee",     ["coffee", "latte", "cappuccino", "espresso", "starbucks", "tims", "tim hortons", "dunkin", "blue bottle"]],
  ["groceries",  ["groceries", "grocery", "supermarket", "trader joe", "whole foods", "tesco", "lidl", "kroger", "walmart food", "вкусвилл", "пятёрочка", "ашан"]],
  ["restaurant", ["restaurant", "dinner out", "lunch out", "brunch", "thai", "sushi", "burger", "ramen", "tacos", "pizza"]],
  ["delivery",   ["uber eats", "ubereats", "doordash", "grubhub", "deliveroo", "wolt", "delivery", "yandex eats", "яндекс еда", "delivery club"]],
  ["transport", ["uber", "lyft", "taxi", "gas", "petrol", "fuel", "metro", "subway ride", "bus", "train", "parking"]],
  ["subscription", ["netflix", "spotify", "apple music", "youtube premium", "icloud", "google drive", "patreon", "subscription"]],
  ["clothing",   ["clothes", "shirt", "shoes", "jacket", "jeans", "dress", "h&m", "zara", "uniqlo", "nike"]],
  ["health",     ["pharmacy", "doctor", "dentist", "gym", "yoga", "vitamins", "supplements"]],
  ["alcohol",    ["beer", "wine", "vodka", "whiskey", "cocktail", "bar tab", "pub"]],
  ["personal",   ["haircut", "barber", "salon", "manicure", "spa"]],
  ["home",       ["furniture", "ikea", "home depot", "amazon basics", "household"]],
  ["entertainment", ["movie", "cinema", "concert", "ticket", "show"]],
  ["travel",     ["flight", "hotel", "airbnb", "booking.com", "trip"]],
  ["other",      []],
];

// Categorize a transaction. Prefers the AI-stored `category` field
// (graph layer); falls back to keyword inference on the note for older
// transactions or when AI didn't extract.
function categorize(noteOrTx) {
  // Backward-compat: callers historically passed a note string. Now also
  // accepts a transaction object { note, category }.
  if (noteOrTx && typeof noteOrTx === "object") {
    if (noteOrTx.category && typeof noteOrTx.category === "string") {
      return noteOrTx.category.toLowerCase();
    }
    return categorizeNote(noteOrTx.note);
  }
  return categorizeNote(noteOrTx);
}

function categorizeNote(note) {
  if (!note) return "other";
  const n = String(note).toLowerCase();
  for (const [name, keywords] of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      if (n.includes(kw)) return name;
    }
  }
  return "other";
}

// Compute the DNA graph. Returns { nodes, edges, summary }.
function compute(state) {
  if (!state || !state.setup) return { nodes: [], edges: [], summary: { setup: false } };

  const todayStr = m.today(state.timezone || "UTC");
  const sym = state.currencySymbol || "$";
  // Filter soft-deleted txs everywhere — delete_transaction marks
  // deletedAt; without this filter, deleted txs poison every aggregation
  // (categories, leaks, trends, milestones).
  const txs = (state.transactions || []).filter(tx => !tx.deletedAt && (tx.kind === "spend" || tx.kind === "bill_payment"));
  const incomes = (state.transactions || []).filter(tx => !tx.deletedAt && tx.kind === "income");

  // ── BILL NODES ──
  const billNodes = Object.values(state.bills || {}).map(b => ({
    type: "bill",
    id: "bill:" + m.billKey(b.name),
    name: b.name,
    amountCents: b.amountCents,
    amount: m.toMoney(b.amountCents, sym),
    dueDate: b.dueDate,
    daysUntilDue: m.daysBetween(todayStr, b.dueDate),
    recurrence: b.recurrence,
    paidThisCycle: !!b.paidThisCycle,
  }));

  // ── CATEGORY NODES ──
  // Group spends by category, compute stats over multiple windows.
  const byCategory = {};
  const day7 = m.addDays(todayStr, -7);
  const day30 = m.addDays(todayStr, -30);
  const day90 = m.addDays(todayStr, -90);
  for (const tx of txs) {
    // Skip bill payments — those are tracked by bill nodes.
    if (tx.kind === "bill_payment") continue;
    const cat = categorize(tx); // prefers tx.category, falls back to note keyword
    if (!byCategory[cat]) byCategory[cat] = {
      total: 0, count: 0,
      total7: 0, total30: 0, total90: 0,
      lastDate: null, daysOfWeek: [0,0,0,0,0,0,0], notes: [],
    };
    const c = byCategory[cat];
    const amt = -tx.amountCents; // spends are negative; flip to positive
    c.total += amt;
    c.count++;
    if (tx.date >= day7) c.total7 += amt;
    if (tx.date >= day30) c.total30 += amt;
    if (tx.date >= day90) c.total90 += amt;
    if (!c.lastDate || tx.date > c.lastDate) c.lastDate = tx.date;
    // Day-of-week histogram (UTC).
    const dow = new Date(tx.date + "T00:00:00Z").getUTCDay();
    c.daysOfWeek[dow]++;
    if (c.notes.length < 4) c.notes.push(tx.note);
  }

  const categoryNodes = Object.entries(byCategory).map(([cat, c]) => ({
    type: "category",
    id: "cat:" + cat,
    name: cat,
    transactions: c.count,
    total: m.toMoney(c.total, sym),
    last7: m.toMoney(c.total7, sym),
    last30: m.toMoney(c.total30, sym),
    last90: m.toMoney(c.total90, sym),
    avgPerTx: c.count > 0 ? m.toMoney(Math.round(c.total / c.count), sym) : null,
    lastDate: c.lastDate,
    pattern: detectPattern(c),
    examples: c.notes,
  }));

  // ── INCOME NODE ──
  let incomeNode = null;
  if (incomes.length > 0) {
    const total30 = incomes.filter(i => i.date >= day30).reduce((s, i) => s + i.amountCents, 0);
    const total90 = incomes.filter(i => i.date >= day90).reduce((s, i) => s + i.amountCents, 0);
    incomeNode = {
      type: "income",
      id: "income:summary",
      count30: incomes.filter(i => i.date >= day30).length,
      total30: m.toMoney(total30, sym),
      total90: m.toMoney(total90, sym),
      lastIncomeDate: incomes[incomes.length - 1].date,
      lastIncomeAmount: m.toMoney(incomes[incomes.length - 1].amountCents, sym),
    };
  }

  // ── EDGES ──
  const edges = [];
  for (const b of billNodes) {
    edges.push({ from: b.id, to: "balance", kind: "depletes", note: b.amount + "/" + b.recurrence });
  }
  // Top categories by 30-day burn → "drains" edges.
  const topCats = categoryNodes.slice().sort((a, b) => parseAmount(b.last30) - parseAmount(a.last30)).slice(0, 5);
  for (const c of topCats) {
    edges.push({ from: c.id, to: "balance", kind: "drains", note: c.last30 + " in 30d" });
  }

  // ── SUMMARY ──
  const totalLast30 = txs.filter(t => t.date >= day30).reduce((s, t) => s + (-t.amountCents), 0);
  const totalLast7 = txs.filter(t => t.date >= day7).reduce((s, t) => s + (-t.amountCents), 0);
  const billsTotal30 = billNodes.reduce((s, b) => {
    if (b.recurrence === "monthly") return s + b.amountCents;
    if (b.recurrence === "weekly")  return s + b.amountCents * 4;
    if (b.recurrence === "biweekly") return s + b.amountCents * 2;
    return s; // once: not a rolling drain
  }, 0);

  // ── POST-BILLS RUNWAY ──
  // After paying every unpaid bill due before payday, what's left? How
  // many days until next paycheck? That's the user's REAL runway.
  const unpaidBills = billNodes.filter(b => !b.paidThisCycle);
  const balance = state.balanceCents || 0;
  const daysToPayday = state.payday ? Math.max(0, m.daysBetween(todayStr, state.payday)) : 0;
  const billsBeforePayday = unpaidBills
    .filter(b => state.payday ? b.dueDate <= state.payday : true)
    .reduce((s, b) => s + b.amountCents, 0);
  const postBillsBalance = Math.max(0, balance - billsBeforePayday);
  const postBillsDailyMin = daysToPayday > 0 && state.payFrequency !== "irregular"
    ? Math.floor(postBillsBalance / daysToPayday)
    : null;

  // ── TREND FLAGS ──
  // Per-category: compare last 7 days vs the 7-day rate over previous 30 days.
  // If 7d > 1.5x prior weekly avg AND >= $20 → flag as "growing".
  const trends = {};
  for (const node of categoryNodes) {
    const c = byCategory[node.name];
    const priorWeekly = (c.total30 - c.total7) / 3;  // weeks 2-4 average
    if (c.total7 >= 2000 && priorWeekly > 0 && c.total7 > priorWeekly * 1.5) {
      trends[node.name] = {
        kind: "growing",
        last7: m.toMoney(c.total7, sym),
        priorWeekly: m.toMoney(Math.round(priorWeekly), sym),
        ratio: (c.total7 / priorWeekly).toFixed(1) + "x",
      };
    }
  }

  // ── LEAKS ──
  // A category counts as a "leak" if its 30d total > $50 AND > 30% of all
  // discretionary spend in 30d. Surfaces the budget-breakers.
  const discretionary30 = totalLast30; // already excludes bill_payments
  const leaks = [];
  for (const node of categoryNodes) {
    const c = byCategory[node.name];
    if (c.total30 >= 5000 && discretionary30 > 0 && c.total30 / discretionary30 >= 0.3) {
      leaks.push({
        name: node.name,
        last30: m.toMoney(c.total30, sym),
        share: Math.round((c.total30 / discretionary30) * 100) + "%",
        // Mark "other" specially — it means uncategorized spends, not a real
        // leak. The bot should nudge the user to add notes so we can
        // categorize properly.
        kind: node.name === "other" ? "uncategorized" : "real",
      });
    }
  }

  // ── COUNT MILESTONES ──
  // Categories that crossed a notable count threshold this week (e.g. 5
  // coffees, 3 take-out lunches). The AI can surface as a friendly "your
  // usual"-style aside or a "want a budget?" prompt.
  const milestones = [];
  for (const node of categoryNodes) {
    if (node.name === "other") continue;
    const c = byCategory[node.name];
    // Count this category's 7d transactions explicitly.
    const last7Count = txs.filter(t => t.date >= day7 && categorize(t) === node.name).length;
    if (last7Count >= 5) {
      milestones.push({
        name: node.name,
        count7: last7Count,
        total7: m.toMoney(c.total7, sym),
      });
    }
  }

  const summary = {
    txCount: txs.length,
    spendLast7: m.toMoney(totalLast7, sym),
    spendLast30: m.toMoney(totalLast30, sym),
    billsMonthlyEstimate: m.toMoney(billsTotal30, sym),
    billsBeforePayday: m.toMoney(billsBeforePayday, sym),
    postBillsBalance: m.toMoney(postBillsBalance, sym),
    postBillsDailyMin: postBillsDailyMin != null ? m.toMoney(postBillsDailyMin, sym) : null,
    daysToPayday,
    topCategories: topCats.slice(0, 3).map(c => ({ name: c.name, last30: c.last30 })),
    trends,
    leaks,
    milestones,
  };

  return {
    nodes: [].concat(billNodes, categoryNodes, incomeNode ? [incomeNode] : []),
    edges,
    summary,
  };
}

// Detect a simple temporal pattern from a category's day-of-week histogram.
function detectPattern(c) {
  if (c.count < 5) return null;
  const dow = c.daysOfWeek;
  const max = Math.max(...dow);
  const total = dow.reduce((s, n) => s + n, 0);
  if (max < 2) return null;
  const ratio = max / total;
  if (ratio < 0.3) return null;
  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const peakIdx = dow.indexOf(max);
  // Weekday vs weekend cluster?
  const weekdays = dow[1] + dow[2] + dow[3] + dow[4] + dow[5];
  const weekend = dow[0] + dow[6];
  if (weekdays / total > 0.7) return "mostly weekdays";
  if (weekend / total > 0.6) return "mostly weekends";
  if (ratio > 0.5) return "peaks on " + dayNames[peakIdx];
  return null;
}

// Helper for sorting categoryNodes by 30d total.
function parseAmount(formatted) {
  const m = String(formatted).replace(/[^0-9.\-]/g, "");
  return parseFloat(m) || 0;
}

// Render a compact text representation of the graph for inclusion in
// the AI's system prompt. Optimized for token efficiency: only the
// information the AI needs to answer questions about patterns.
function renderForPrompt(graph) {
  if (!graph || !graph.summary || graph.summary.setup === false) return "";
  const lines = ["DNA SUMMARY:"];
  lines.push("- last 7d spend: " + graph.summary.spendLast7);
  lines.push("- last 30d spend: " + graph.summary.spendLast30);
  lines.push("- monthly bills load: " + graph.summary.billsMonthlyEstimate);
  if (graph.summary.postBillsBalance && graph.summary.daysToPayday > 0) {
    lines.push("- after bills runway: " + graph.summary.postBillsBalance
      + " for " + graph.summary.daysToPayday + " days"
      + (graph.summary.postBillsDailyMin ? " (" + graph.summary.postBillsDailyMin + "/day)" : ""));
  }
  if (graph.summary.topCategories.length) {
    lines.push("- top categories last 30d: " + graph.summary.topCategories
      .map(c => c.name + " (" + c.last30 + ")").join(", "));
  }
  if (graph.summary.leaks && graph.summary.leaks.length) {
    lines.push("- BIGGEST DISCRETIONARY LEAKS: " + graph.summary.leaks
      .map(l => l.name + " (" + l.last30 + " = " + l.share + " of discretionary"
        + (l.kind === "uncategorized" ? "; UNCATEGORIZED — nudge user to tag notes" : "")
        + ")").join(", "));
  }
  if (graph.summary.trends && Object.keys(graph.summary.trends).length) {
    const trendStrs = Object.entries(graph.summary.trends)
      .map(([cat, t]) => cat + " up " + t.ratio + " (" + t.last7 + " vs ~" + t.priorWeekly + ")");
    lines.push("- TRENDING UP: " + trendStrs.join(", "));
  }
  if (graph.summary.milestones && graph.summary.milestones.length) {
    lines.push("- 7-DAY COUNT MILESTONES: " + graph.summary.milestones
      .map(m => m.name + " (" + m.count7 + "x this week, " + m.total7 + ")").join(", "));
  }

  const cats = graph.nodes.filter(n => n.type === "category" && n.transactions >= 3);
  if (cats.length) {
    lines.push("CATEGORIES (≥3 txs):");
    for (const c of cats.slice(0, 8)) {
      const patternClause = c.pattern ? " · " + c.pattern : "";
      lines.push("- " + c.name + ": " + c.transactions + " txs, " + c.last30 + " in 30d, avg " + c.avgPerTx + patternClause);
    }
  }

  const bills = graph.nodes.filter(n => n.type === "bill");
  if (bills.length) {
    lines.push("BILLS:");
    for (const b of bills) {
      lines.push("- " + b.name + ": " + b.amount + "/" + b.recurrence + " · due " + b.dueDate + " (in " + b.daysUntilDue + "d)" + (b.paidThisCycle ? " · paid" : ""));
    }
  }

  return lines.join("\n");
}

module.exports = { compute, renderForPrompt, categorize };
