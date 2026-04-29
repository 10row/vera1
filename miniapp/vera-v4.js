"use strict";
// SpendYes v4 Mini App — AAA redesign.
// Reads /api/v4/view/:sid. Read-only. All state changes happen in chat.
//
// The product compressed: open the app, see ONE number, feel calm,
// close. Everything below the hero exists to support that moment.
//
// React 18, no JSX, no build step. Single file ~700 LOC.

var h = React.createElement;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;
var useCallback = React.useCallback;
var useMemo = React.useMemo;

var API_BASE = "";

// ── DESIGN TOKENS ────────────────────────────────────────────
var C = {
  bg: "#0F0F0F", card: "#171717", cardHi: "#1F1F1F",
  border: "#262626", borderHi: "#333",
  text: "#EFEAE2", sub: "#9A9A9A", muted: "#5A5A5A",
  green: "#4FB888", amber: "#F0A050", red: "#E45656",
  greenSoft: "rgba(79,184,136,0.14)",
  amberSoft: "rgba(240,160,80,0.14)",
  redSoft: "rgba(228,86,86,0.14)",
};

// ── HELPERS ──────────────────────────────────────────────────
function authHeaders() {
  var initData = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp.initData : "";
  if (!initData && window.TG_INIT_DATA) initData = window.TG_INIT_DATA;
  var headers = { "Content-Type": "application/json" };
  if (initData) headers["X-Telegram-Init-Data"] = initData;
  return headers;
}

function fmtMoney(cents, sym) {
  var s = sym || "$";
  if (cents == null) return s + "0";
  var neg = cents < 0;
  var abs = Math.abs(cents);
  var dollars = Math.floor(abs / 100);
  var change = abs % 100;
  // Compact: hide cents on whole-dollar values for readability.
  var str = dollars.toLocaleString("en-US") + (change ? "." + String(change).padStart(2, "0") : "");
  return (neg ? "-" : "") + s + str;
}

function fmtMoneyFull(cents, sym) {
  var s = sym || "$";
  if (cents == null) return s + "0.00";
  var neg = cents < 0;
  var abs = Math.abs(cents);
  return (neg ? "-" : "") + s + Math.floor(abs / 100).toLocaleString("en-US") + "." + String(abs % 100).padStart(2, "0");
}

function colorForState(s) {
  if (s === "over") return C.red;
  if (s === "tight") return C.amber;
  return C.green;
}

function softColorForState(s) {
  if (s === "over") return C.redSoft;
  if (s === "tight") return C.amberSoft;
  return C.greenSoft;
}

// Build a map of envelope key → friendly name. Used everywhere we
// might otherwise leak the internal ekey ("vietnam_trip") to the user.
function buildNameMap(envelopes) {
  var map = {};
  (envelopes || []).forEach(function(e) { if (e && e.key) map[e.key] = e.name || e.key; });
  return map;
}

// Pretty label for a transaction. Returns { primary, secondary }.
//   primary   — the main line of text in the transaction row
//   secondary — small muted label below (or null)
// Rules:
//   - If a note exists → note is primary; envelope name (if any) is
//     secondary. Never show ekey.
//   - If no note but envelope exists → envelope name is primary,
//     no secondary.
//   - Otherwise → "—".
function txLabel(tx, nameMap) {
  var note = (tx.note || "").trim();
  var envName = tx.envelopeKey && nameMap ? (nameMap[tx.envelopeKey] || null) : null;
  if (note && envName) return { primary: note, secondary: envName };
  if (note) return { primary: note, secondary: null };
  if (envName) return { primary: envName, secondary: null };
  return { primary: "—", secondary: null };
}

function relativeDay(dateStr, today) {
  if (!dateStr) return "";
  if (dateStr === today) return "Today";
  var d1 = new Date(dateStr + "T00:00:00Z").getTime();
  var d2 = new Date(today + "T00:00:00Z").getTime();
  var diff = Math.round((d1 - d2) / 86400000);
  if (diff === -1) return "Yesterday";
  if (diff < -1 && diff >= -6) return Math.abs(diff) + " days ago";
  var d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── HERO ─────────────────────────────────────────────────────
// Sacred. Just the status pill, the big number, and one line of context.
// No inputs, no buttons, no decisions. The morning glance.
// Decision support ("can I afford X?") lives in chat — the right place
// for conversation. The hero stays calm.
function Hero(props) {
  var v = props.view;
  var col = colorForState(v.state);

  var pill = h("div", {
    style: {
      display: "inline-flex", alignItems: "center", gap: 6,
      background: softColorForState(v.state),
      color: col, fontSize: 12, fontWeight: 600,
      padding: "5px 12px", borderRadius: 999,
      letterSpacing: "0.02em", marginBottom: 16,
    },
  },
    h("span", { style: { width: 6, height: 6, borderRadius: "50%", background: col } }),
    v.statusWord || (v.state === "over" ? "Over" : v.state === "tight" ? "Tight" : "Calm")
  );

  var heroNumber, heroLabel, subContext;
  if (v.state === "over") {
    heroNumber = v.deficitFormatted;
    heroLabel = "over for this period";
    subContext = v.daysToPayday + " days to payday · " + v.dailyPaceFormatted + "/day after that";
  } else {
    heroNumber = v.todayRemainingFormatted;
    heroLabel = "free today";
    subContext = v.dailyPaceFormatted + "/day · " + v.daysToPayday + " days to payday";
  }

  return h("div", { style: { padding: "32px 20px 22px", textAlign: "center" } },
    pill,
    h("div", {
      style: {
        fontFamily: "'Lora',serif", fontSize: 60, fontWeight: 500,
        color: col, lineHeight: 1.0, letterSpacing: "-0.02em",
        transition: "color 0.4s ease",
      },
    }, heroNumber),
    h("div", { style: { fontSize: 13, color: C.sub, marginTop: 10, letterSpacing: "0.02em" } }, heroLabel),
    h("div", { style: { fontSize: 12, color: C.muted, marginTop: 6 } }, subContext)
  );
}

// ── HEATMAP CALENDAR ─────────────────────────────────────────
// 30 days as colored squares. Color from spend vs that day's safe
// pace. Tap a square → expand inline showing that day's transactions.
function Heatmap(props) {
  var heatmap = props.heatmap || [];
  var dailyPace = props.dailyPaceCents || 0;
  var sym = props.sym || "$";
  var txs = props.txs || [];
  var nameMap = props.nameMap || {};
  var openState = useState(null);
  var open = openState[0], setOpen = openState[1];

  // Subtle haptic feedback on Telegram clients that support it.
  function tapHaptic() {
    try {
      var hf = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
      if (hf && hf.impactOccurred) hf.impactOccurred("light");
    } catch (e) { /* ignore */ }
  }

  // Color thresholds: 0 spend = dim grey, <50% pace = green,
  // 50-100% pace = green-medium, 100-150% = amber, >150% = red
  function colorForDay(spent) {
    if (spent === 0) return { bg: C.cardHi, fg: C.muted };
    if (dailyPace <= 0) return { bg: C.cardHi, fg: C.muted };
    var ratio = spent / dailyPace;
    if (ratio <= 0.5) return { bg: "rgba(79,184,136,0.55)", fg: "#0F0F0F" };
    if (ratio <= 1.0) return { bg: "rgba(79,184,136,0.85)", fg: "#0F0F0F" };
    if (ratio <= 1.5) return { bg: "rgba(240,160,80,0.85)", fg: "#0F0F0F" };
    return { bg: "rgba(228,86,86,0.85)", fg: "#FFFFFF" };
  }

  function dayLabel(d) { return d.slice(8); /* day-of-month */ }

  return h("div", { style: { padding: "8px 16px 0" } },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 } },
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, "Last 30 days"),
      h("div", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: C.muted } },
        h("div", { style: { width: 8, height: 8, borderRadius: 2, background: "rgba(79,184,136,0.55)" } }),
        h("span", null, "under"),
        h("div", { style: { width: 8, height: 8, borderRadius: 2, background: "rgba(240,160,80,0.85)", marginLeft: 4 } }),
        h("span", null, "over")
      )
    ),
    h("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "repeat(10, 1fr)",
        gap: 4,
      },
    },
      heatmap.map(function(d, i) {
        var col = colorForDay(d.spentCents);
        var isOpen = open === d.date;
        return h("div", {
          key: d.date,
          onClick: function() { tapHaptic(); setOpen(isOpen ? null : d.date); },
          style: {
            aspectRatio: "1 / 1",
            background: isOpen ? C.text : col.bg,
            color: isOpen ? "#0F0F0F" : col.fg,
            borderRadius: 4,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 600,
            cursor: "pointer",
            border: isOpen ? "2px solid " + C.text : "none",
            transition: "all 0.15s ease",
          },
        }, dayLabel(d.date));
      })
    ),
    open ? DayDetail({ date: open, txs: txs, sym: sym, nameMap: nameMap, today: heatmap[heatmap.length - 1] && heatmap[heatmap.length - 1].date }) : null
  );
}

function DayDetail(props) {
  var dayTxs = (props.txs || []).filter(function(tx) { return tx.date === props.date; });
  var total = dayTxs.reduce(function(a, tx) {
    if (tx.kind === "spend" || tx.kind === "bill_payment") return a + tx.amountCents;
    if (tx.kind === "refund") return a - Math.abs(tx.amountCents);
    return a;
  }, 0);
  var dateLabel = props.today ? relativeDay(props.date, props.today) : props.date;
  return h("div", {
    style: { marginTop: 10, padding: "12px 14px", background: C.card, borderRadius: 10, border: "1px solid " + C.border },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
      h("div", { style: { fontSize: 12, fontWeight: 600 } }, dateLabel),
      h("div", { style: { fontSize: 11, color: C.sub } }, fmtMoney(total, props.sym) + " spent")
    ),
    dayTxs.length === 0
      ? h("div", { style: { fontSize: 11, color: C.muted, padding: "6px 0" } }, "Nothing logged.")
      : dayTxs.map(function(tx) {
          var lbl = txLabel(tx, props.nameMap);
          return h("div", {
            key: tx.id,
            style: { display: "flex", justifyContent: "space-between", padding: "7px 0", fontSize: 12, borderTop: "1px solid " + C.border, alignItems: "center" },
          },
            h("div", { style: { flex: 1, overflow: "hidden", marginRight: 8 } },
              h("div", { style: { color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lbl.primary),
              lbl.secondary ? h("div", { style: { color: C.muted, fontSize: 10, marginTop: 1 } }, lbl.secondary) : null
            ),
            h("div", { style: { color: tx.kind === "refund" ? C.green : C.text, fontFamily: "'Lora',serif" } },
              (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), props.sym)
            )
          );
        })
  );
}

// ── TODAY STRIP ──────────────────────────────────────────────
function TodayStrip(props) {
  var v = props.view;
  var sym = v.currencySymbol || "$";
  var nameMap = props.nameMap || {};
  var todayTxs = (props.txs || []).filter(function(tx) {
    if (tx.date !== props.today) return false;
    return tx.kind === "spend" || tx.kind === "refund" || tx.kind === "bill_payment";
  });

  return h("div", { style: { padding: "20px 16px 0" } },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 } },
      h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, "Today"),
      h("div", { style: { fontSize: 11, color: C.sub } },
        "spent " + v.todaySpentFormatted)
    ),
    todayTxs.length === 0
      ? h("div", {
          style: {
            background: C.card, border: "1px dashed " + C.border, borderRadius: 12,
            padding: "16px 14px", textAlign: "center", fontSize: 12, color: C.muted,
          },
        }, "Nothing yet today. Send your bot a voice note 👇")
      : h("div", { style: { background: C.card, border: "1px solid " + C.border, borderRadius: 12, overflow: "hidden" } },
          todayTxs.map(function(tx, i) {
            var lbl = txLabel(tx, nameMap);
            return h("div", {
              key: tx.id,
              style: {
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "11px 14px", borderTop: i === 0 ? "none" : "1px solid " + C.border,
              },
            },
              h("div", { style: { flex: 1, overflow: "hidden" } },
                h("div", { style: { fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lbl.primary),
                lbl.secondary ? h("div", { style: { fontSize: 10, color: C.muted, marginTop: 2 } }, lbl.secondary) : null
              ),
              h("div", {
                style: {
                  fontFamily: "'Lora',serif", fontSize: 14,
                  color: tx.kind === "refund" ? C.green : C.text, marginLeft: 8,
                },
              }, (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), sym))
            );
          })
        )
  );
}

// ── ENVELOPE SECTIONS (Bills / Budgets / Goals) ─────────────
function SectionHeader(props) {
  return h("div", {
    style: { display: "flex", alignItems: "center", padding: "20px 16px 8px", gap: 8 },
  },
    h("div", { style: { fontSize: 16 } }, props.icon),
    h("div", { style: { fontSize: 12, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, props.title),
    props.count != null ? h("div", { style: { fontSize: 12, color: C.muted } }, "· " + props.count) : null
  );
}

function BillCard(props) {
  var e = props.env;
  var sym = props.sym;
  var label;
  var col = C.text;
  if (e.daysUntilDue == null) label = "no date";
  else if (e.daysUntilDue < 0) { label = "overdue"; col = C.red; }
  else if (e.daysUntilDue === 0) { label = "today"; col = C.amber; }
  else if (e.daysUntilDue === 1) { label = "tomorrow"; col = C.amber; }
  else if (e.daysUntilDue <= 7) { label = "in " + e.daysUntilDue + " days"; col = C.amber; }
  else label = "in " + e.daysUntilDue + " days";

  return h("div", {
    style: {
      background: C.card, border: "1px solid " + C.border, borderRadius: 12,
      padding: "12px 14px", marginBottom: 8,
      display: "flex", justifyContent: "space-between", alignItems: "center",
    },
  },
    h("div", null,
      h("div", { style: { fontSize: 14, fontWeight: 500 } }, e.name),
      h("div", { style: { fontSize: 11, color: col, marginTop: 3 } }, label)
    ),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 16 } }, e.amountFormatted)
  );
}

function BudgetCard(props) {
  var e = props.env;
  var sym = props.sym;
  var amt = e.amountCents || 0;
  var spent = e.spentCents || 0;
  var pct = amt > 0 ? Math.min(100, Math.round((spent / amt) * 100)) : 0;
  var col = pct >= 100 ? C.red : pct >= 80 ? C.amber : C.green;
  return h("div", {
    style: {
      background: C.card, border: "1px solid " + C.border, borderRadius: 12,
      padding: "12px 14px", marginBottom: 8,
    },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
      h("div", { style: { fontSize: 14, fontWeight: 500 } }, e.name),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 14 } },
        fmtMoney(spent, sym) + " / " + e.amountFormatted)
    ),
    h("div", {
      style: {
        height: 4, background: C.border, borderRadius: 2,
        overflow: "hidden", marginTop: 8,
      },
    },
      h("div", {
        style: {
          height: "100%", width: pct + "%", background: col,
          transition: "width 0.4s ease",
        },
      })
    ),
    h("div", { style: { fontSize: 10, color: C.muted, marginTop: 4 } }, pct + "% used")
  );
}

function GoalCard(props) {
  var e = props.env;
  var sym = props.sym;
  var target = e.targetCents || e.amountCents || 0;
  var funded = e.fundedCents || 0;
  var pct = target > 0 ? Math.min(100, Math.round((funded / target) * 100)) : 0;
  var col = pct >= 100 ? C.green : C.green;
  var remaining = Math.max(0, target - funded);
  return h("div", {
    style: {
      background: C.card, border: "1px solid " + C.border, borderRadius: 12,
      padding: "14px 14px", marginBottom: 8,
    },
  },
    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 } },
      h("div", null,
        h("div", { style: { fontSize: 14, fontWeight: 500 } }, e.name),
        h("div", { style: { fontSize: 11, color: C.muted, marginTop: 2 } },
          fmtMoney(funded, sym) + " of " + fmtMoney(target, sym))
      ),
      h("div", { style: { textAlign: "right" } },
        h("div", { style: { fontFamily: "'Lora',serif", fontSize: 18, color: col, lineHeight: 1 } }, pct + "%"),
        remaining > 0
          ? h("div", { style: { fontSize: 10, color: C.muted, marginTop: 4 } }, fmtMoney(remaining, sym) + " to go")
          : h("div", { style: { fontSize: 10, color: C.green, marginTop: 4, fontWeight: 600 } }, "🎉 reached")
      )
    ),
    h("div", {
      style: {
        height: 6, background: C.border, borderRadius: 3,
        overflow: "hidden",
      },
    },
      h("div", {
        style: {
          height: "100%", width: pct + "%", background: col,
          transition: "width 0.4s ease",
          boxShadow: pct >= 100 ? "0 0 8px " + C.green : "none",
        },
      })
    )
  );
}

// ── HISTORY (collapsed; chip filters) ───────────────────────
function History(props) {
  var openState = useState(false);
  var open = openState[0], setOpen = openState[1];
  var filterState = useState("all");
  var filter = filterState[0], setFilter = filterState[1];
  var nameMap = props.nameMap || {};

  var allTxs = (props.txs || []).filter(function(tx) {
    return tx.kind === "spend" || tx.kind === "refund" || tx.kind === "bill_payment";
  });

  // Filter chips
  var today = props.today;
  function applyFilter(txs) {
    if (filter === "all") return txs;
    if (filter === "week") {
      var wkAgo = props.dateMinusN ? props.dateMinusN(today, 6) : today;
      return txs.filter(function(tx) { return tx.date >= wkAgo; });
    }
    if (filter === "month") return txs.filter(function(tx) { return tx.date.startsWith(today.slice(0, 7)); });
    if (filter === "big") return txs.filter(function(tx) { return Math.abs(tx.amountCents) >= 50_00; });
    return txs;
  }

  var filtered = applyFilter(allTxs);

  // Group by date
  var groups = [];
  var byDate = {};
  filtered.forEach(function(tx) {
    if (!byDate[tx.date]) { byDate[tx.date] = []; groups.push(tx.date); }
    byDate[tx.date].push(tx);
  });

  return h("div", { style: { padding: "20px 16px 0" } },
    !open
      ? h("button", {
          onClick: function() { setOpen(true); },
          style: {
            width: "100%", background: C.card, border: "1px solid " + C.border,
            borderRadius: 12, padding: "12px", cursor: "pointer",
            fontSize: 13, color: C.text, fontFamily: "'Inter',sans-serif",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          },
        }, h("span", { style: { fontSize: 14 } }, "📜"), "View history (" + allTxs.length + ")")
      : h("div", null,
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 } },
            h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 } }, "History"),
            h("div", {
              onClick: function() { setOpen(false); },
              style: { fontSize: 11, color: C.sub, cursor: "pointer", padding: "2px 8px" },
            }, "Close")
          ),
          // Chips
          h("div", { style: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" } },
            ["all", "week", "month", "big"].map(function(c) {
              var on = c === filter;
              return h("div", {
                key: c, onClick: function() { setFilter(c); },
                style: {
                  padding: "5px 12px", borderRadius: 999, fontSize: 11,
                  background: on ? C.text : C.card, color: on ? "#0F0F0F" : C.sub,
                  border: "1px solid " + (on ? C.text : C.border),
                  fontWeight: on ? 600 : 500, cursor: "pointer",
                  textTransform: "capitalize",
                },
              }, c === "big" ? "$50+" : c);
            })
          ),
          // Groups
          filtered.length === 0
            ? h("div", { style: { textAlign: "center", padding: "24px 0", color: C.muted, fontSize: 12 } }, "Nothing here.")
            : groups.map(function(date) {
                return h("div", { key: date, style: { marginBottom: 14 } },
                  h("div", { style: { fontSize: 11, color: C.muted, marginBottom: 4 } },
                    relativeDay(date, today) + (date === today ? "" : " · " + date)),
                  h("div", { style: { background: C.card, border: "1px solid " + C.border, borderRadius: 10, overflow: "hidden" } },
                    byDate[date].map(function(tx, i) {
                      var lbl = txLabel(tx, nameMap);
                      return h("div", {
                        key: tx.id,
                        style: {
                          display: "flex", justifyContent: "space-between", padding: "10px 12px",
                          fontSize: 12, borderTop: i === 0 ? "none" : "1px solid " + C.border, alignItems: "center",
                        },
                      },
                        h("div", { style: { flex: 1, overflow: "hidden", marginRight: 8 } },
                          h("div", { style: { color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, lbl.primary),
                          lbl.secondary ? h("div", { style: { color: C.muted, fontSize: 10, marginTop: 1 } }, lbl.secondary) : null
                        ),
                        h("div", { style: { fontFamily: "'Lora',serif", color: tx.kind === "refund" ? C.green : C.text } },
                          (tx.kind === "refund" ? "+" : "") + fmtMoney(Math.abs(tx.amountCents), props.sym))
                      );
                    })
                  )
                );
              })
        )
  );
}

// ── ERROR / EMPTY STATES ────────────────────────────────────
function Skeleton() {
  var sh = {
    background: "linear-gradient(90deg," + C.card + " 25%," + C.border + " 50%," + C.card + " 75%)",
    backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: 12,
  };
  return h("div", { style: { padding: 20 } },
    h("style", null, "@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }"),
    h("div", { style: Object.assign({}, sh, { width: 80, height: 22, margin: "20px auto", borderRadius: 999 }) }),
    h("div", { style: Object.assign({}, sh, { width: "60%", height: 56, margin: "0 auto 8px" }) }),
    h("div", { style: Object.assign({}, sh, { width: "40%", height: 14, margin: "0 auto 24px" }) }),
    h("div", { style: Object.assign({}, sh, { height: 60, marginBottom: 16 }) }),
    h("div", { style: Object.assign({}, sh, { height: 100, marginBottom: 12 }) }),
    h("div", { style: Object.assign({}, sh, { height: 70, marginBottom: 8 }) }),
    h("div", { style: Object.assign({}, sh, { height: 70, marginBottom: 8 }) })
  );
}

function statusLabel(s) {
  return ({
    "ok": "Authenticated", "no-init-data": "No Telegram session",
    "bad-signature": "Server token mismatch", "stale": "Session expired",
    "no-bot-token": "Bot not configured", "malformed": "Malformed session",
    "parse-error": "Couldn't read session",
  })[s] || (s || "Unknown");
}

function ErrorState(props) {
  var diagState = useState(null);
  var diag = diagState[0], setDiag = diagState[1];
  var loadState = useState(false);
  var loadingDiag = loadState[0], setLoadingDiag = loadState[1];

  function fetchDiag() {
    setLoadingDiag(true);
    fetch(API_BASE + "/api/v4/whoami", { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) { setDiag(d); })
      .catch(function(e) { setDiag({ status: "network", hint: e.message }); })
      .then(function() { setLoadingDiag(false); });
  }

  return h("div", {
    style: {
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      flex: 1, padding: "48px 24px", minHeight: "70vh",
    },
  },
    h("div", { style: { fontSize: 32, marginBottom: 16 } }, "·  ·"),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 22, fontWeight: 500, textAlign: "center", marginBottom: 10 } },
      /telegram|identity/i.test(props.errMsg || "") ? "Can't see your Telegram" : "Couldn't load"),
    h("div", { style: { color: C.sub, fontSize: 14, lineHeight: 1.5, textAlign: "center", maxWidth: 300, marginBottom: 24 } },
      /telegram|identity/i.test(props.errMsg || "")
        ? "Open from inside Telegram — tap the ≡ Dashboard button or send /app to your bot."
        : "Tap retry."),
    h("button", {
      onClick: props.onRetry,
      style: {
        background: C.green, color: "#0F0F0F", border: "none", borderRadius: 10,
        padding: "12px 28px", fontSize: 14, fontWeight: 600, cursor: "pointer",
        fontFamily: "'Inter',sans-serif",
      },
    }, "Try again"),
    !diag && !loadingDiag
      ? h("div", { onClick: fetchDiag, style: { marginTop: 28, color: C.muted, fontSize: 12, cursor: "pointer", borderBottom: "1px dotted " + C.muted } }, "Diagnostics")
      : null,
    loadingDiag ? h("div", { style: { marginTop: 28, color: C.muted, fontSize: 12 } }, "Checking…") : null,
    diag ? h("div", { style: { marginTop: 24, padding: "14px 16px", maxWidth: 320, width: "100%", background: C.card, border: "1px solid " + C.border, borderRadius: 12, fontSize: 12, lineHeight: 1.5 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
        h("div", { style: { width: 8, height: 8, borderRadius: "50%", background: diag.status === "ok" ? C.green : (diag.status === "stale" ? C.amber : C.red) } }),
        h("div", { style: { fontWeight: 600 } }, statusLabel(diag.status))
      ),
      diag.hint ? h("div", { style: { color: C.sub } }, diag.hint) : null,
      diag.user ? h("div", { style: { color: C.muted, fontSize: 11, marginTop: 8 } }, "Signed in as " + (diag.user.first_name || "user") + " · id " + diag.user.id) : null
    ) : null
  );
}

function NotSetUpState() {
  return h("div", {
    style: {
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      flex: 1, padding: "48px 24px", minHeight: "70vh",
    },
  },
    h("div", {
      style: {
        width: 72, height: 72, borderRadius: "50%", background: C.card,
        border: "1px solid " + C.border, display: "flex", alignItems: "center",
        justifyContent: "center", marginBottom: 22, fontSize: 32,
      },
    }, "👋"),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 24, fontWeight: 500, marginBottom: 10, textAlign: "center" } }, "Hey"),
    h("div", { style: { color: C.sub, fontSize: 14, lineHeight: 1.55, textAlign: "center", maxWidth: 280 } },
      "Send your bot a voice note — your balance, when you get paid, any bills. Your dashboard fills in from there.")
  );
}

// ── DASHBOARD ────────────────────────────────────────────────
function Dashboard(props) {
  var v = props.view;
  var sym = v.currencySymbol || "$";
  var txs = props.txs || [];
  var heatmap = props.heatmap || [];
  var today = (heatmap.length ? heatmap[heatmap.length - 1].date : "");

  var envs = v.envelopes || [];
  var bills = envs.filter(function(e) { return e.kind === "bill"; });
  var budgets = envs.filter(function(e) { return e.kind === "budget"; });
  var goals = envs.filter(function(e) { return e.kind === "goal"; });
  var nameMap = buildNameMap(envs);

  // dueNow appears as part of bills card sort (most urgent first), not a separate section.
  bills.sort(function(a, b) {
    var da = a.daysUntilDue == null ? 9999 : a.daysUntilDue;
    var db = b.daysUntilDue == null ? 9999 : b.daysUntilDue;
    return da - db;
  });

  function dateMinusN(d, n) {
    var dt = new Date(d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - n);
    return dt.toISOString().slice(0, 10);
  }

  return h("div", null,
    h(Hero, { view: v, sid: props.sid }),
    h(Heatmap, { heatmap: heatmap, dailyPaceCents: v.dailyPaceCents, sym: sym, txs: txs, nameMap: nameMap }),
    h(TodayStrip, { view: v, txs: txs, today: today, nameMap: nameMap }),
    bills.length > 0 ? h("div", null,
      h(SectionHeader, { icon: "📌", title: "Bills", count: bills.length }),
      h("div", { style: { padding: "0 16px" } },
        bills.map(function(e) { return h(BillCard, { key: e.key, env: e, sym: sym }); }))
    ) : null,
    budgets.length > 0 ? h("div", null,
      h(SectionHeader, { icon: "📊", title: "Budgets", count: budgets.length }),
      h("div", { style: { padding: "0 16px" } },
        budgets.map(function(e) { return h(BudgetCard, { key: e.key, env: e, sym: sym }); }))
    ) : null,
    goals.length > 0 ? h("div", null,
      h(SectionHeader, { icon: "🎯", title: "Goals", count: goals.length }),
      h("div", { style: { padding: "0 16px" } },
        goals.map(function(e) { return h(GoalCard, { key: e.key, env: e, sym: sym }); }))
    ) : null,
    h(History, { txs: txs, sym: sym, today: today, dateMinusN: dateMinusN, nameMap: nameMap }),
    h("div", {
      style: { textAlign: "center", padding: "28px 16px 32px", color: C.muted, fontSize: 11 },
    }, "Read-only · changes happen in chat")
  );
}

// ── APP ──────────────────────────────────────────────────────
function App() {
  var dataState = useState(null);
  var data = dataState[0], setData = dataState[1];
  var loadingState = useState(true);
  var loading = loadingState[0], setLoading = loadingState[1];
  var errorState = useState(false);
  var error = errorState[0], setError = errorState[1];
  var lastErrState = useState("");
  var lastErr = lastErrState[0], setLastErr = lastErrState[1];

  var sid = useRef(null);

  var loadView = useCallback(function() {
    if (!sid.current) return;
    setError(false);
    fetch(API_BASE + "/api/v4/view/" + sid.current, { headers: authHeaders() })
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(d) {
        setData({
          view: d.view || { setup: false },
          txs: d.recentTransactions || [],
          heatmap: d.heatmap || [],
        });
        setError(false);
      })
      .catch(function(e) {
        setLastErr(e.message);
        setError(true);
      })
      .then(function() { setLoading(false); });
  }, []);

  useEffect(function() {
    var attempts = 0;
    function tryStart() {
      var tid = window.TELEGRAM_USER_ID;
      var hasInit = !!window.TG_INIT_DATA;
      if ((!tid || tid === "dev") && typeof window.refreshTgIdentity === "function") {
        var snap = window.refreshTgIdentity();
        tid = snap.id || tid;
        hasInit = !!snap.initData;
      }
      if (tid && tid !== "dev") {
        sid.current = "tg_" + tid;
        loadView();
        return;
      }
      attempts++;
      if (attempts < 6) { setTimeout(tryStart, 250); return; }
      setLastErr("No Telegram identity available.");
      setLoading(false); setError(true);
    }
    tryStart();
  }, []);

  // Refresh on visibility change (when user comes back to app after chatting).
  useEffect(function() {
    function onVis() { if (!document.hidden && sid.current) loadView(); }
    document.addEventListener("visibilitychange", onVis);
    return function() { document.removeEventListener("visibilitychange", onVis); };
  }, [loadView]);

  var content;
  if (loading && !data) content = h(Skeleton, null);
  else if (error && !data) content = h(ErrorState, { onRetry: loadView, errMsg: lastErr });
  else if (!data || !data.view || !data.view.setup) content = h(NotSetUpState, null);
  else content = h(Dashboard, {
    view: data.view, txs: data.txs, heatmap: data.heatmap, sid: sid.current,
  });

  return h("div", {
    style: {
      display: "flex", flexDirection: "column", minHeight: "100vh",
      background: C.bg, color: C.text, fontFamily: "'Inter',sans-serif", fontSize: 14,
    },
  }, content);
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App, null));
