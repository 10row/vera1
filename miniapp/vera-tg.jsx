// miniapp/vera-tg.jsx — V3 Mini App
// Full screen dark dashboard. One scrollable view.
// Fuel gauge → Envelopes → Recent transactions → Savings.
// No chat. No tabs. No settings.

"use strict";

const { useState, useEffect, useCallback } = React;

const API_BASE = "";

// ── THEME ────────────────────────────────────
const C = {
  bg:     "#0F0F0F",
  card:   "#1A1A1A",
  border: "#2A2A2A",
  text:   "#E8E4DF",
  sub:    "#888",
  muted:  "#555",
  green:  "#4CAF87",
  amber:  "#F0A050",
  red:    "#E05555",
};

// ── HELPERS ──────────────────────────────────
function fmtMoney(cents, sym = "$") {
  if (cents == null) return sym + "0";
  const neg = cents < 0, abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString();
  return (neg ? "-" : "") + sym + whole;
}

function gaugeColor(ratio) {
  if (ratio > 0.5) return C.green;
  if (ratio > 0.2) return C.amber;
  return C.red;
}

function groupByDay(txs) {
  const groups = {};
  for (const tx of txs) {
    const d = tx.date || "unknown";
    if (!groups[d]) groups[d] = [];
    groups[d].push(tx);
  }
  return Object.entries(groups).sort((a, b) => b[0].localeCompare(a[0]));
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === today.toISOString().slice(0, 10)) return "Today";
  if (dateStr === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ── STYLES ───────────────────────────────────
const styles = {
  page: {
    minHeight: "100%", background: C.bg, color: C.text,
    fontFamily: "'Inter', sans-serif", fontSize: 14,
    padding: "0 16px 32px", overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 11, color: C.sub, textTransform: "uppercase",
    letterSpacing: "0.1em", fontWeight: 500, marginBottom: 8,
  },
  card: {
    background: C.card, borderRadius: 12, padding: "14px 16px",
    marginBottom: 8, border: `1px solid ${C.border}`,
  },
  row: {
    display: "flex", justifyContent: "space-between",
    alignItems: "center",
  },
  loading: {
    display: "flex", alignItems: "center", justifyContent: "center",
    height: "100%", color: C.sub, fontSize: 16,
  },
  error: {
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", height: "100%", color: C.red, padding: 32,
    textAlign: "center",
  },
};

// ── FUEL GAUGE ───────────────────────────────
function FuelGauge({ pic, sym }) {
  const freeToday = pic.freeRemainingTodayCents ?? 0;
  const dailyPace = pic.dailyPaceCents ?? 1;
  const ratio = dailyPace > 0 ? Math.max(0, Math.min(1, freeToday / dailyPace)) : 0;
  const color = gaugeColor(ratio);
  const pct = Math.round(ratio * 100);

  // Arc gauge using SVG
  const size = 200, stroke = 12, radius = (size - stroke) / 2;
  const circ = Math.PI * radius; // half circle
  const offset = circ - (circ * ratio);

  return React.createElement("div", {
    style: { textAlign: "center", padding: "24px 0 16px" },
  },
    React.createElement("svg", {
      width: size, height: size / 2 + 20, viewBox: `0 0 ${size} ${size / 2 + 20}`,
    },
      // Background arc
      React.createElement("path", {
        d: `M ${stroke / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${size / 2}`,
        fill: "none", stroke: C.border, strokeWidth: stroke, strokeLinecap: "round",
      }),
      // Filled arc
      React.createElement("path", {
        d: `M ${stroke / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - stroke / 2} ${size / 2}`,
        fill: "none", stroke: color, strokeWidth: stroke, strokeLinecap: "round",
        strokeDasharray: circ, strokeDashoffset: offset,
        style: { transition: "stroke-dashoffset 0.6s ease, stroke 0.3s ease" },
      }),
    ),
    // Hero number
    React.createElement("div", {
      style: {
        fontSize: 42, fontFamily: "'Lora', serif", fontWeight: 500,
        color, marginTop: -20, letterSpacing: "-0.02em",
      },
    }, fmtMoney(freeToday, sym)),
    React.createElement("div", {
      style: { fontSize: 13, color: C.sub, marginTop: 4 },
    }, "Free today"),
    // Pace + days
    React.createElement("div", {
      style: { fontSize: 12, color: C.muted, marginTop: 8 },
    }, fmtMoney(pic.dailyPaceCents, sym) + "/day · " + (pic.daysLeft ?? "?") + " days left"),
  );
}

// ── ENVELOPE CARD ────────────────────────────
function EnvelopeCard({ env, sym }) {
  const [expanded, setExpanded] = useState(false);
  const isGoal = env.rhythm === "ongoing" && env.targetCents > 0;
  const isBudget = ["daily", "weekly", "monthly", "on_income"].includes(env.rhythm);

  let progress = 0, progressLabel = "", progressColor = C.green;
  if (isGoal) {
    progress = env.targetCents > 0 ? Math.min(1, (env.fundedCents || 0) / env.targetCents) : 0;
    progressLabel = fmtMoney(env.fundedCents, sym) + " / " + fmtMoney(env.targetCents, sym);
    progressColor = C.green;
  } else if (isBudget) {
    const total = env.amountCents || 1;
    progress = Math.min(1, (env.spentCents || 0) / total);
    progressLabel = fmtMoney(env.spentCents, sym) + " / " + fmtMoney(env.amountCents, sym);
    progressColor = progress > 0.9 ? C.red : progress > 0.7 ? C.amber : C.green;
  }

  const remaining = env.remainingCents ?? (env.amountCents - (env.spentCents || 0));

  return React.createElement("div", {
    style: { ...styles.card, cursor: "pointer" },
    onClick: () => setExpanded(!expanded),
  },
    // Header row
    React.createElement("div", { style: styles.row },
      React.createElement("div", null,
        React.createElement("span", {
          style: { fontSize: 14, fontWeight: 500 },
        }, env.name),
        env.isDue ? React.createElement("span", {
          style: {
            fontSize: 10, color: C.red, marginLeft: 8,
            background: C.red + "22", borderRadius: 10, padding: "2px 6px",
          },
        }, "DUE") : null,
        env.priority === "essential" ? React.createElement("span", {
          style: {
            fontSize: 10, color: C.amber, marginLeft: 6,
          },
        }, "●") : null,
      ),
      React.createElement("span", {
        style: {
          fontSize: 15, fontFamily: "'Lora', serif", fontWeight: 500,
          color: remaining < 0 ? C.red : C.text,
        },
      }, isGoal ? fmtMoney(env.fundedCents, sym) : fmtMoney(remaining, sym)),
    ),
    // Progress bar
    (isBudget || isGoal) ? React.createElement("div", {
      style: { marginTop: 8 },
    },
      React.createElement("div", {
        style: {
          height: 3, background: C.border, borderRadius: 2, overflow: "hidden",
        },
      },
        React.createElement("div", {
          style: {
            height: "100%", width: (progress * 100) + "%",
            background: progressColor, borderRadius: 2,
            transition: "width 0.4s ease",
          },
        }),
      ),
      React.createElement("div", {
        style: { fontSize: 11, color: C.sub, marginTop: 4 },
      }, progressLabel),
    ) : null,
    // Expanded details
    expanded ? React.createElement("div", {
      style: { marginTop: 8, fontSize: 12, color: C.sub },
    },
      React.createElement("div", null, "Rhythm: " + env.rhythm +
        (env.intervalDays && env.rhythm !== "daily" ? " (" + env.intervalDays + "d)" : "")),
      env.nextDate ? React.createElement("div", null, "Next: " + env.nextDate) : null,
      env.keywords?.length > 0 ? React.createElement("div", null,
        "Keywords: " + env.keywords.join(", ")) : null,
      env.fundRate > 0 ? React.createElement("div", null,
        "Auto-fund: " + (env.fundRate / 100) + "% of income") : null,
      env.fundAmountCents > 0 ? React.createElement("div", null,
        "Auto-fund: " + fmtMoney(env.fundAmountCents, sym) + "/income") : null,
    ) : null,
  );
}

// ── TRANSACTION ROW ──────────────────────────
function TxRow({ tx, sym }) {
  const isRefund = tx.type === "refund";
  return React.createElement("div", {
    style: { ...styles.row, padding: "6px 0" },
  },
    React.createElement("div", null,
      React.createElement("span", {
        style: { fontSize: 13 },
      }, tx.description || "unnamed"),
      tx.envelope && tx.envelope !== "free" ? React.createElement("span", {
        style: { fontSize: 11, color: C.muted, marginLeft: 6 },
      }, tx.envelope) : null,
    ),
    React.createElement("span", {
      style: {
        fontSize: 13, fontFamily: "'Lora', serif",
        color: isRefund ? C.green : C.text,
      },
    }, (isRefund ? "+" : "") + fmtMoney(tx.amountCents, sym)),
  );
}

// ── MAIN APP ─────────────────────────────────
function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const userId = window.TELEGRAM_USER_ID || "dev";
      const res = await fetch(API_BASE + "/api/v3/picture/" + userId);
      if (!res.ok) throw new Error("Server error " + res.status);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Pull to refresh via Telegram's built-in
  useEffect(() => {
    if (window.Telegram?.WebApp) {
      // Polling refresh every 30s when visible
      const interval = setInterval(fetchData, 30000);
      return () => clearInterval(interval);
    }
  }, [fetchData]);

  if (loading && !data) {
    return React.createElement("div", { style: styles.loading }, "Loading...");
  }
  if (error && !data) {
    return React.createElement("div", { style: styles.error },
      React.createElement("div", null, "Couldn't load data"),
      React.createElement("div", {
        style: { fontSize: 12, marginTop: 8, color: C.sub },
      }, error),
      React.createElement("button", {
        onClick: fetchData,
        style: {
          marginTop: 16, padding: "8px 24px", background: C.green,
          border: "none", borderRadius: 8, color: "#fff", cursor: "pointer",
        },
      }, "Retry"),
    );
  }

  const pic = data?.pic;
  const state = data?.state;
  if (!pic || !pic.setup) {
    return React.createElement("div", { style: styles.loading },
      "Open the chat to get started.",
    );
  }

  const sym = pic.currencySymbol || state?.currencySymbol || "$";

  // Separate envelopes by type
  const allEnvs = pic.envelopes || [];
  const dueEnvs = allEnvs.filter(e => e.isDue);
  const budgetEnvs = allEnvs.filter(e =>
    !e.isDue && ["daily", "weekly", "monthly", "on_income"].includes(e.rhythm)
  );
  const recurringEnvs = allEnvs.filter(e =>
    !e.isDue && !["daily", "weekly", "monthly", "on_income", "ongoing"].includes(e.rhythm) && e.rhythm !== "once"
  );
  const onceEnvs = allEnvs.filter(e => !e.isDue && e.rhythm === "once");
  const goalEnvs = allEnvs.filter(e => e.rhythm === "ongoing");

  // Recent transactions (spending only, last 7 days)
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);
  const recentTxs = (state?.transactions || [])
    .filter(tx => tx.date >= weekAgoStr && (tx.type === "spend" || tx.type === "refund"))
    .slice(-20).reverse();
  const txGroups = groupByDay(recentTxs);

  // Show more toggle
  const [showAllEnvs, setShowAllEnvs] = useState(false);
  const activeEnvs = [...dueEnvs, ...budgetEnvs, ...recurringEnvs, ...onceEnvs];
  const visibleEnvs = showAllEnvs ? activeEnvs : activeEnvs.slice(0, 5);

  return React.createElement("div", { style: styles.page },
    // ── Fuel Gauge ──
    React.createElement(FuelGauge, { pic, sym }),

    // ── Balance context ──
    React.createElement("div", {
      style: {
        ...styles.card, display: "flex", justifyContent: "space-around",
        textAlign: "center",
      },
    },
      React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 11, color: C.sub } }, "Balance"),
        React.createElement("div", {
          style: { fontSize: 16, fontFamily: "'Lora', serif", fontWeight: 500 },
        }, fmtMoney(pic.balanceCents, sym)),
      ),
      React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 11, color: C.sub } }, "Reserved"),
        React.createElement("div", {
          style: { fontSize: 16, fontFamily: "'Lora', serif", fontWeight: 500, color: C.amber },
        }, fmtMoney(pic.totalReservedCents, sym)),
      ),
      React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 11, color: C.sub } }, "Free"),
        React.createElement("div", {
          style: {
            fontSize: 16, fontFamily: "'Lora', serif", fontWeight: 500,
            color: (pic.freeCents || 0) < 0 ? C.red : C.green,
          },
        }, fmtMoney(pic.freeCents, sym)),
      ),
    ),

    // ── Envelopes ──
    activeEnvs.length > 0 ? React.createElement("div", { style: styles.section },
      React.createElement("div", { style: styles.sectionTitle }, "Envelopes"),
      visibleEnvs.map((env, i) =>
        React.createElement(EnvelopeCard, { key: env.key || i, env, sym })
      ),
      activeEnvs.length > 5 && !showAllEnvs ? React.createElement("div", {
        style: {
          textAlign: "center", color: C.sub, fontSize: 12,
          cursor: "pointer", padding: 8,
        },
        onClick: () => setShowAllEnvs(true),
      }, "Show all " + activeEnvs.length + " envelopes") : null,
    ) : null,

    // ── Savings/Goals ──
    goalEnvs.length > 0 ? React.createElement("div", { style: styles.section },
      React.createElement("div", { style: styles.sectionTitle }, "Savings & Goals"),
      goalEnvs.map((env, i) =>
        React.createElement(EnvelopeCard, { key: env.key || i, env, sym })
      ),
      pic.totalSavedCents > 0 ? React.createElement("div", {
        style: {
          textAlign: "center", fontSize: 12, color: C.sub, marginTop: 4,
        },
      }, "Total saved: " + fmtMoney(pic.totalSavedCents, sym)) : null,
    ) : null,

    // ── Recent Transactions ──
    recentTxs.length > 0 ? React.createElement("div", { style: styles.section },
      React.createElement("div", { style: styles.sectionTitle }, "Recent"),
      txGroups.map(([date, txs]) =>
        React.createElement("div", { key: date },
          React.createElement("div", {
            style: { fontSize: 11, color: C.muted, marginTop: 8, marginBottom: 4 },
          }, formatDate(date)),
          txs.map((tx, i) =>
            React.createElement(TxRow, { key: tx.id || i, tx, sym })
          ),
        )
      ),
    ) : null,

    // ── Cycle Stats ──
    pic.cycleStats ? React.createElement("div", {
      style: { ...styles.card, marginTop: 8 },
    },
      React.createElement("div", { style: styles.row },
        React.createElement("span", { style: { fontSize: 12, color: C.sub } }, "This cycle"),
        React.createElement("span", {
          style: { fontSize: 13, fontFamily: "'Lora', serif" },
        }, fmtMoney(pic.cycleStats.totalSpent, sym) + " spent"),
      ),
      React.createElement("div", {
        style: { fontSize: 11, color: C.muted, marginTop: 4 },
      }, "Avg " + fmtMoney(pic.cycleStats.dailyAvg, sym) + "/day · " +
        pic.cycleStats.daysInCycle + " days in"),
    ) : null,
  );
}

// ── MOUNT ────────────────────────────────────
ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(App)
);
