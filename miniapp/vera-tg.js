// miniapp/vera-tg.js — SpendYes Mini App (AAA rewrite)
// Single-file React 18 dashboard, no JSX, no Babel.
"use strict";

var h = React.createElement;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;
var useCallback = React.useCallback;
var useMemo = React.useMemo;

// ── CONFIG ──────────────────────────────────────────────────────
var API_BASE = "";
var C = {
  bg: "#0F0F0F", card: "#1A1A1A", border: "#2A2A2A", muted: "#555",
  text: "#E8E4DF", sub: "#999", green: "#4CAF87", amber: "#F0A050",
  red: "#E05555",
};

var RHYTHM_LABELS = {
  daily: "/day", weekly: "/wk", monthly: "/mo", on_income: "/cycle"
};

// ── STYLES ──────────────────────────────────────────────────────
var S = {
  page: {
    display: "flex", flexDirection: "column", minHeight: "100vh",
    background: C.bg, color: C.text, fontFamily: "'Inter',sans-serif",
    fontSize: 14, position: "relative",
  },
  scroll: {
    flex: 1, overflowY: "auto", padding: "0 16px 24px",
    WebkitOverflowScrolling: "touch",
  },
  card: {
    background: C.card, borderRadius: 12, padding: "14px 16px",
    marginBottom: 10, border: "1px solid " + C.border,
  },
  row: {
    display: "flex", justifyContent: "space-between",
    alignItems: "baseline", marginBottom: 4,
  },
  label: {
    color: C.sub, fontSize: 11, textTransform: "uppercase",
    letterSpacing: "0.06em", fontWeight: 500,
  },
  value: { fontSize: 20, fontFamily: "'Lora',serif", fontWeight: 500 },
  heroValue: {
    fontSize: 34, fontFamily: "'Lora',serif", fontWeight: 500,
    letterSpacing: "-0.02em", lineHeight: 1.1,
  },
  heroLabel: { fontSize: 12, color: C.sub, marginTop: 2 },
  small: { fontSize: 12, color: C.sub },
  sectionTitle: {
    color: C.sub, fontSize: 11, textTransform: "uppercase",
    letterSpacing: "0.06em", fontWeight: 600, marginBottom: 8, marginTop: 20,
  },
  pill: function(c) {
    return {
      display: "inline-block", background: c + "22", color: c,
      borderRadius: 20, padding: "2px 8px", fontSize: 10,
      fontWeight: 600, marginLeft: 6, verticalAlign: "middle",
    };
  },
  progressTrack: {
    height: 4, background: C.border, borderRadius: 2, overflow: "hidden",
    marginTop: 8,
  },
  progressFill: function(pct, col) {
    return {
      height: "100%", width: Math.min(100, Math.max(0, pct)) + "%",
      background: col, borderRadius: 2, transition: "width 0.4s ease",
    };
  },
  thickTrack: {
    height: 8, background: C.border, borderRadius: 4, overflow: "hidden",
    marginTop: 8,
  },
};

// ── HELPERS ──────────────────────────────────────────────────────
function colourFor(ratio) {
  return ratio >= 0.5 ? C.green : ratio >= 0.2 ? C.amber : C.red;
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

function formatCents(cents, sym) {
  var sign = cents < 0 ? "-" : "";
  var abs = Math.abs(cents);
  return sign + (sym || "$") + (abs / 100).toFixed(2);
}

function relativeDay(dateStr) {
  if (!dateStr) return "";
  var now = new Date();
  var d = new Date(dateStr + "T00:00:00");
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  var opts = { weekday: "short", month: "short", day: "numeric" };
  return d.toLocaleDateString("en-US", opts);
}

function timeAgo(ts) {
  if (!ts) return "";
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  var m = Math.floor(diff / 60);
  if (m < 60) return m + "m ago";
  var hr = Math.floor(m / 60);
  if (hr < 24) return hr + "h ago";
  return Math.floor(hr / 24) + "d ago";
}

function authHeaders() {
  var initData = window.Telegram && window.Telegram.WebApp
    ? window.Telegram.WebApp.initData : null;
  // Fall back to the snapshot captured at load time (survives SDK state changes)
  if (!initData && window.TG_INIT_DATA) initData = window.TG_INIT_DATA;
  var headers = {};
  if (initData) headers["X-Telegram-Init-Data"] = initData;
  return headers;
}

function groupTransactionsByDay(txs) {
  var groups = [];
  var map = {};
  (txs || []).forEach(function(tx) {
    var day = (tx.date || "").slice(0, 10);
    if (!map[day]) {
      map[day] = { day: day, label: relativeDay(day), txs: [] };
      groups.push(map[day]);
    }
    map[day].txs.push(tx);
  });
  return groups;
}

// ── PULL TO REFRESH HOOK ────────────────────────────────────────
function usePullToRefresh(onRefresh, scrollRef) {
  var startY = useRef(0);
  var pulling = useRef(false);
  var pullDist = useState(0);
  var setPullDist = pullDist[1];
  var dist = pullDist[0];
  var threshold = 80;

  useEffect(function() {
    var el = scrollRef.current;
    if (!el) return;

    function onTouchStart(e) {
      if (el.scrollTop <= 0) {
        startY.current = e.touches[0].clientY;
        pulling.current = true;
      }
    }
    function onTouchMove(e) {
      if (!pulling.current) return;
      var dy = e.touches[0].clientY - startY.current;
      if (dy > 0 && el.scrollTop <= 0) {
        setPullDist(Math.min(dy * 0.5, 120));
        if (dy > 10) e.preventDefault();
      } else {
        pulling.current = false;
        setPullDist(0);
      }
    }
    function onTouchEnd() {
      if (pulling.current && dist >= threshold) {
        onRefresh();
      }
      pulling.current = false;
      setPullDist(0);
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return function() {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [onRefresh, dist]);

  return dist;
}

// ── FUEL GAUGE ──────────────────────────────────────────────────
function FuelGauge(props) {
  var ratio = props.ratio;
  var size = props.size || 140;
  var r = (size - 14) / 2;
  var cx = size / 2;
  var cy = size / 2;
  var startAngle = 135;
  var endAngle = 405;
  var range = endAngle - startAngle;
  var clamped = clamp01(ratio);
  var fillAngle = startAngle + clamped * range;

  function toRad(a) { return (a - 90) * Math.PI / 180; }
  function arcPath(start, end) {
    var sx = cx + r * Math.cos(toRad(start));
    var sy = cy + r * Math.sin(toRad(start));
    var ex = cx + r * Math.cos(toRad(end));
    var ey = cy + r * Math.sin(toRad(end));
    var large = (end - start) > 180 ? 1 : 0;
    return "M " + sx + " " + sy + " A " + r + " " + r + " 0 " + large + " 1 " + ex + " " + ey;
  }

  var col = colourFor(clamped);

  return h("svg", {
    width: size, height: size,
    viewBox: "0 0 " + size + " " + size,
    style: { display: "block" },
  },
    // track
    h("path", {
      d: arcPath(startAngle, endAngle), fill: "none",
      stroke: C.border, strokeWidth: 8, strokeLinecap: "round",
    }),
    // fill
    clamped > 0.01 ? h("path", {
      d: arcPath(startAngle, fillAngle), fill: "none",
      stroke: col, strokeWidth: 8, strokeLinecap: "round",
      style: { transition: "d 0.4s ease" },
    }) : null,
    // tick marks at 25%, 50%, 75%
    [0.25, 0.5, 0.75].map(function(pct, i) {
      var a = startAngle + pct * range;
      var ir = r - 5;
      var or2 = r + 5;
      return h("line", {
        key: i,
        x1: cx + ir * Math.cos(toRad(a)),
        y1: cy + ir * Math.sin(toRad(a)),
        x2: cx + or2 * Math.cos(toRad(a)),
        y2: cy + or2 * Math.sin(toRad(a)),
        stroke: C.muted, strokeWidth: 1.5, strokeLinecap: "round",
      });
    })
  );
}

// ── SKELETON LOADER ─────────────────────────────────────────────
function Skeleton() {
  var shimmer = {
    background: "linear-gradient(90deg, " + C.card + " 25%, " + C.border + " 50%, " + C.card + " 75%)",
    backgroundSize: "200% 100%",
    animation: "shimmer 1.5s infinite",
    borderRadius: 8,
  };

  return h("div", { style: { padding: "24px 16px" } },
    // inject keyframes
    h("style", null,
      "@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }"
    ),
    // gauge placeholder
    h("div", { style: { textAlign: "center", marginBottom: 24 } },
      h("div", { style: Object.assign({}, shimmer, {
        width: 140, height: 140, borderRadius: "50%", margin: "0 auto",
      }) })
    ),
    // stats row
    h("div", { style: { display: "flex", gap: 8, marginBottom: 16 } },
      h("div", { style: Object.assign({}, shimmer, { flex: 1, height: 60 }) }),
      h("div", { style: Object.assign({}, shimmer, { flex: 1, height: 60 }) }),
      h("div", { style: Object.assign({}, shimmer, { flex: 1, height: 60 }) })
    ),
    // cards
    h("div", { style: Object.assign({}, shimmer, { height: 70, marginBottom: 10 }) }),
    h("div", { style: Object.assign({}, shimmer, { height: 70, marginBottom: 10 }) }),
    h("div", { style: Object.assign({}, shimmer, { height: 70, marginBottom: 10 }) })
  );
}

// ── PULL INDICATOR ──────────────────────────────────────────────
function PullIndicator(props) {
  var dist = props.dist;
  if (dist < 5) return null;
  var opacity = clamp01(dist / 80);
  var rotation = Math.min(dist * 3, 360);
  return h("div", {
    style: {
      textAlign: "center", padding: "8px 0", color: C.sub,
      opacity: opacity, transition: "opacity 0.2s",
    }
  },
    h("svg", {
      width: 24, height: 24, viewBox: "0 0 24 24",
      style: { transform: "rotate(" + rotation + "deg)", transition: "transform 0.1s" },
    },
      h("path", {
        d: "M12 4V1L8 5l4 4V6a6 6 0 016 6 6 6 0 01-6 6 6 6 0 01-6-6H4a8 8 0 008 8 8 8 0 008-8 8 8 0 00-8-8z",
        fill: C.sub,
      })
    )
  );
}

// ── REFRESH INDICATOR (top bar) ─────────────────────────────────
function RefreshBar(props) {
  if (!props.show) return null;
  return h("div", {
    style: {
      position: "absolute", top: 0, left: 0, right: 0, height: 3,
      background: "linear-gradient(90deg, " + C.green + ", " + C.amber + ", " + C.green + ")",
      backgroundSize: "200% 100%",
      animation: "refreshSlide 1s linear infinite",
      zIndex: 10,
    },
  },
    h("style", null,
      "@keyframes refreshSlide { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }"
    )
  );
}

// ── UPCOMING STRIP ──────────────────────────────────────────────
function UpcomingStrip(props) {
  var items = props.items;
  if (!items || items.length === 0) return null;

  return h("div", { style: { marginBottom: 12 } },
    h("div", { style: S.sectionTitle }, "Upcoming"),
    h("div", {
      style: {
        display: "flex", gap: 8, overflowX: "auto",
        WebkitOverflowScrolling: "touch", paddingBottom: 4,
        scrollbarWidth: "none", msOverflowStyle: "none",
      },
    },
      items.map(function(item, i) {
        var overdue = item.isDue || (item.daysUntilDue != null && item.daysUntilDue < 0);
        var borderCol = overdue ? C.red : C.border;
        var textCol = overdue ? C.red : C.text;
        return h("div", {
          key: item.key || i,
          style: {
            flexShrink: 0, background: C.card,
            border: "1px solid " + borderCol, borderRadius: 10,
            padding: "8px 14px", minWidth: 110,
          },
        },
          h("div", {
            style: { fontSize: 13, fontWeight: 500, color: textCol, marginBottom: 2 },
          }, item.name),
          h("div", { style: { fontSize: 14, fontWeight: 600, color: textCol } },
            item.amountFormatted
          ),
          h("div", {
            style: { fontSize: 11, color: overdue ? C.red : C.sub, marginTop: 2 },
          }, overdue ? "Overdue" :
            item.daysUntilDue === 0 ? "Due today" :
            item.daysUntilDue === 1 ? "Tomorrow" :
            "in " + item.daysUntilDue + "d"
          )
        );
      })
    )
  );
}

// ── DUE ALERT ───────────────────────────────────────────────────
function DueAlert(props) {
  var due = props.due;
  if (!due || due.length === 0) return null;

  return h("div", {
    style: Object.assign({}, S.card, {
      borderColor: C.red + "88",
      background: C.red + "11",
      marginBottom: 12,
    }),
  },
    h("div", {
      style: { fontSize: 11, fontWeight: 600, color: C.red, textTransform: "uppercase",
        letterSpacing: "0.06em", marginBottom: 8 },
    }, "Overdue"),
    due.map(function(d, i) {
      return h("div", {
        key: i,
        style: Object.assign({}, S.row, { marginBottom: i < due.length - 1 ? 6 : 0 }),
      },
        h("span", { style: { fontSize: 14 } }, d.name),
        h("span", { style: { color: C.red, fontWeight: 600, fontSize: 14 } },
          d.amountFormatted || formatCents(d.amountCents)
        )
      );
    })
  );
}

// ── STATS ROW ───────────────────────────────────────────────────
function StatsRow(props) {
  var pic = props.pic;
  return h("div", { style: { display: "flex", gap: 8, marginBottom: 14 } },
    StatCell("Pace", pic.dailyPaceFormatted || "$0"),
    StatCell("Balance", pic.balanceFormatted || "$0"),
    StatCell("Days left", pic.daysLeft != null ? String(pic.daysLeft) : "--")
  );
}

function StatCell(label, value) {
  return h("div", {
    style: Object.assign({}, S.card, {
      flex: 1, textAlign: "center", marginBottom: 0,
    }),
  },
    h("div", { style: S.label }, label),
    h("div", {
      style: { fontSize: 16, fontFamily: "'Lora',serif", fontWeight: 500, marginTop: 4 },
    }, value)
  );
}

// ── BUDGET CARD ─────────────────────────────────────────────────
function BudgetCard(props) {
  var env = props.env;
  var spent = env.spentCents || 0;
  var amount = env.amountCents || 1;
  var remaining = env.remainingCents != null ? env.remainingCents : (amount - spent);
  var ratio = clamp01(remaining / amount);
  var col = colourFor(ratio);
  var rhythmSuffix = RHYTHM_LABELS[env.rhythm] || "";

  return h("div", { style: S.card },
    h("div", { style: S.row },
      h("div", { style: { display: "flex", alignItems: "center" } },
        h("span", { style: { fontSize: 14, fontWeight: 500 } }, env.name)
      ),
      h("span", { style: { fontSize: 15, fontWeight: 600, color: col } },
        (env.amountFormatted || "$0") + rhythmSuffix
      )
    ),
    h("div", { style: S.progressTrack },
      h("div", { style: S.progressFill(ratio * 100, col) })
    ),
    h("div", {
      style: { fontSize: 12, color: C.sub, marginTop: 5, display: "flex", justifyContent: "space-between" },
    },
      h("span", null, formatCents(remaining, props.sym) + " left"),
      spent > 0 ? h("span", null, formatCents(spent, props.sym) + " spent") : null
    )
  );
}

// ── BILL CARD ───────────────────────────────────────────────────
function BillCard(props) {
  var env = props.env;
  var overdue = env.isDue;
  var col = overdue ? C.red : C.text;
  var countdown = overdue ? "Overdue" :
    env.daysUntilDue === 0 ? "Due today" :
    env.daysUntilDue === 1 ? "Due tomorrow" :
    env.daysUntilDue != null ? "Due in " + env.daysUntilDue + "d" :
    env.nextDate ? "Next: " + env.nextDate : "";

  return h("div", {
    style: Object.assign({}, S.card, overdue ? { borderColor: C.red + "55" } : {}),
  },
    h("div", { style: S.row },
      h("div", { style: { display: "flex", alignItems: "center" } },
        h("span", { style: { fontSize: 14, fontWeight: 500 } }, env.name),
        overdue ? h("span", { style: S.pill(C.red) }, "OVERDUE") : null
      ),
      h("span", { style: { fontSize: 15, fontWeight: 600, color: col } },
        env.amountFormatted || "$0"
      )
    ),
    countdown ? h("div", {
      style: { fontSize: 12, color: overdue ? C.red : C.sub, marginTop: 4 },
    }, countdown) : null,
    env.reservedCents > 0 ? h("div", {
      style: { fontSize: 12, color: C.sub, marginTop: 2 },
    }, (env.reservedFormatted || formatCents(env.reservedCents, props.sym)) + " reserved") : null
  );
}

// ── GOAL CARD ───────────────────────────────────────────────────
function GoalCard(props) {
  var env = props.env;
  var funded = env.fundedCents || 0;
  var target = env.targetCents || 1;
  var ratio = clamp01(funded / target);
  var pct = Math.round(ratio * 100);
  var col = C.green;

  return h("div", { style: S.card },
    h("div", { style: S.row },
      h("span", { style: { fontSize: 14, fontWeight: 500 } }, env.name),
      h("span", { style: { fontSize: 13, fontWeight: 600, color: col } }, pct + "%")
    ),
    h("div", { style: S.thickTrack },
      h("div", { style: Object.assign({}, S.progressFill(pct, col), { borderRadius: 4 }) })
    ),
    h("div", {
      style: { fontSize: 12, color: C.sub, marginTop: 5 },
    }, (env.fundedFormatted || "$0") + " / " + (env.targetFormatted || "$0"))
  );
}

// ── EMPTY STATE ─────────────────────────────────────────────────
function EmptyState(props) {
  return h("div", {
    style: {
      textAlign: "center", padding: "16px 0 8px", color: C.muted, fontSize: 13,
    },
  }, props.text);
}

// ── TRANSACTION GROUP ───────────────────────────────────────────
function TransactionGroup(props) {
  var group = props.group;
  var sym = props.sym || "$";

  var txColorMap = {
    income: C.green, refund: C.amber, envelope_payment: C.red,
  };
  var txSignMap = {
    income: "+", refund: "+",
  };

  return h("div", { style: { marginBottom: 12 } },
    h("div", {
      style: {
        fontSize: 11, color: C.sub, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: "0.04em",
        marginBottom: 6, paddingLeft: 2,
      },
    }, group.label),
    group.txs.map(function(tx, i) {
      var col = txColorMap[tx.type] || C.text;
      var sign = txSignMap[tx.type] || "-";
      var envLabel = tx.envelope && tx.envelope !== "free" ? tx.envelope : null;

      return h("div", {
        key: tx.id || i,
        style: {
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "8px 2px",
          borderBottom: i < group.txs.length - 1 ? "1px solid " + C.border : "none",
        },
      },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", {
            style: { fontSize: 13, fontWeight: 400, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis" },
          }, tx.description || tx.type),
          envLabel ? h("div", {
            style: { fontSize: 11, color: C.sub, marginTop: 1 },
          }, envLabel) : null
        ),
        h("div", {
          style: {
            fontSize: 13, fontWeight: 500, color: col,
            marginLeft: 12, flexShrink: 0,
          },
        }, sign + sym + (Math.abs(tx.amountCents) / 100).toFixed(2))
      );
    })
  );
}

// ── SUMMARY FOOTER ──────────────────────────────────────────────
function SummaryFooter(props) {
  var pic = props.pic;
  var rows = [
    ["This week", pic.thisWeekSpentFormatted || "$0", null],
    ["This month", pic.thisMonthSpentFormatted || "$0", null],
  ];
  if (pic.cycleStats) {
    rows.push(["Cycle avg", pic.cycleStats.dailyAvgFormatted || "$0", "daily"]);
    rows.push(["Transactions", String(pic.cycleStats.txCount || 0), null]);
  }
  if (pic.totalSavedCents > 0) {
    rows.push(["Saved", pic.totalSavedFormatted || "$0", "highlight"]);
  }

  return h("div", { style: Object.assign({}, S.card, { marginTop: 8 }) },
    rows.map(function(r, i) {
      return h("div", {
        key: i,
        style: Object.assign({}, S.row, {
          marginBottom: i < rows.length - 1 ? 6 : 0,
        }),
      },
        h("span", { style: S.small }, r[0]),
        h("span", {
          style: {
            fontSize: 13, fontWeight: 500,
            color: r[2] === "highlight" ? C.green : C.text,
          },
        }, r[1], r[2] === "daily" ? h("span", {
          style: { fontSize: 11, color: C.sub, marginLeft: 4 },
        }, "/day") : null)
      );
    })
  );
}

// ── ERROR STATE ─────────────────────────────────────────────────
// Friendly empty state with a primary retry. Diagnostics are gated behind
// a quiet text link — an end user sees a calm screen, a developer (or a
// user we're triaging with) can tap "Diagnostics" to see what went wrong.
function ErrorState(props) {
  var diagState = useState(null);
  var diag = diagState[0], setDiag = diagState[1];
  var loadingState = useState(false);
  var loadingDiag = loadingState[0], setLoadingDiag = loadingState[1];

  function HUMAN_TITLE() {
    if (!props.errMsg) return "Something's not loading";
    if (/identity|initData|telegram/i.test(props.errMsg)) return "We can't see your Telegram identity";
    return "Something's not loading";
  }
  function HUMAN_BODY() {
    if (!props.errMsg) return "We couldn't reach your dashboard. Tap retry to try again.";
    if (/identity|initData|telegram/i.test(props.errMsg)) {
      return "Open this Mini App from inside Telegram — tap the Menu button next to the message input, or send /app to your bot.";
    }
    return "We couldn't reach your dashboard. Tap retry to try again.";
  }

  function fetchDiagnostic() {
    if (loadingDiag) return;
    setLoadingDiag(true);
    setDiag(null);
    fetch(API_BASE + "/api/v3/whoami", { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) { setDiag(d); })
      .catch(function(e) { setDiag({ status: "network", hint: e.message }); })
      .then(function() { setLoadingDiag(false); });
  }

  function statusLabel(status) {
    return ({
      "ok": "Authenticated",
      "no-init-data": "No Telegram session",
      "bad-signature": "Server token mismatch",
      "stale": "Session expired",
      "no-bot-token": "Bot not configured",
      "malformed": "Malformed session data",
      "parse-error": "Couldn't read session data",
      "network": "Couldn't reach the server",
    })[status] || (status || "Unknown");
  }
  function statusColor(status) {
    return status === "ok" ? C.green : status === "stale" ? C.amber : C.red;
  }

  return h("div", {
    style: {
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", flex: 1, padding: "48px 24px", minHeight: "70vh",
    },
  },
    h("div", {
      style: {
        width: 64, height: 64, borderRadius: "50%",
        background: C.card, border: "1px solid " + C.border,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 20, fontSize: 28, color: C.sub,
      },
    }, "·  ·"),
    h("div", {
      style: {
        fontFamily: "'Lora',serif", fontSize: 22, fontWeight: 500,
        textAlign: "center", marginBottom: 10, lineHeight: 1.3,
        letterSpacing: "-0.01em",
      },
    }, HUMAN_TITLE()),
    h("div", {
      style: {
        color: C.sub, fontSize: 14, lineHeight: 1.5, textAlign: "center",
        maxWidth: 300, marginBottom: 24,
      },
    }, HUMAN_BODY()),
    h("button", {
      onClick: props.onRetry,
      style: {
        background: C.green, color: "#fff", border: "none",
        borderRadius: 10, padding: "12px 28px", fontSize: 14,
        fontWeight: 600, cursor: "pointer", fontFamily: "'Inter',sans-serif",
        letterSpacing: "0.01em",
      },
    }, "Try again"),
    diag === null && !loadingDiag
      ? h("div", {
          onClick: fetchDiagnostic,
          style: {
            marginTop: 28, color: C.muted, fontSize: 12,
            cursor: "pointer", borderBottom: "1px dotted " + C.muted,
            paddingBottom: 1, letterSpacing: "0.02em",
          },
        }, "Diagnostics")
      : null,
    loadingDiag
      ? h("div", { style: { marginTop: 28, color: C.muted, fontSize: 12 } }, "Checking…")
      : null,
    diag ? h("div", {
      style: {
        marginTop: 24, padding: "14px 16px", maxWidth: 320, width: "100%",
        background: C.card, border: "1px solid " + C.border, borderRadius: 10,
        fontSize: 12, lineHeight: 1.5,
      },
    },
      h("div", {
        style: {
          display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
        },
      },
        h("div", {
          style: {
            width: 8, height: 8, borderRadius: "50%",
            background: statusColor(diag.status),
          },
        }),
        h("div", {
          style: { fontWeight: 600, color: C.text },
        }, statusLabel(diag.status))
      ),
      diag.hint ? h("div", {
        style: { color: C.sub, fontSize: 12 },
      }, diag.hint) : null,
      diag.user ? h("div", {
        style: { color: C.muted, fontSize: 11, marginTop: 8 },
      }, "Signed in as " + (diag.user.first_name || "user") + " · id " + diag.user.id) : null
    ) : null
  );
}

// ── NOT SET UP STATE ────────────────────────────────────────────
// Shown to legitimate first-time users (auth worked, but they haven't told
// the bot anything yet). Keep this screen quiet, warm, and free of any
// developer chrome — diagnostics only belong on the error path.
function NotSetUpState() {
  return h("div", {
    style: {
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", flex: 1, padding: "48px 24px", minHeight: "70vh",
    },
  },
    h("div", {
      style: {
        width: 64, height: 64, borderRadius: "50%",
        background: C.card, border: "1px solid " + C.border,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 20, fontSize: 28,
      },
    }, "👋"),
    h("div", {
      style: {
        fontFamily: "'Lora',serif", fontSize: 22, fontWeight: 500,
        textAlign: "center", marginBottom: 10, lineHeight: 1.3,
        letterSpacing: "-0.01em",
      },
    }, "You're all set"),
    h("div", {
      style: {
        color: C.sub, fontSize: 14, lineHeight: 1.5, textAlign: "center",
        maxWidth: 300,
      },
    }, "Send your bot a message to add your first expense — your dashboard fills in from there.")
  );
}

// ── DASHBOARD ───────────────────────────────────────────────────
function Dashboard(props) {
  var pic = props.pic;
  var sym = pic.currencySymbol || "$";

  // Pace-based fuel gauge
  var dailyPace = pic.dailyPaceCents || 1;
  var freeToday = pic.freeRemainingTodayCents != null ? pic.freeRemainingTodayCents : 0;
  var paceRatio = freeToday <= 0 ? 0 : clamp01(freeToday / dailyPace);
  var paceCol = colourFor(paceRatio);

  // Cycle indicator
  var cycleStats = pic.cycleStats || {};
  var daysInCycle = cycleStats.daysInCycle || pic.daysLeft || 0;
  var dayOfCycle = daysInCycle > 0 && pic.daysLeft != null
    ? Math.max(1, daysInCycle - pic.daysLeft + 1) : 1;

  // Categorize envelopes
  var envs = pic.envelopes || [];
  var budgetRhythms = { daily: 1, weekly: 1, monthly: 1, on_income: 1 };
  var budgets = [];
  var bills = [];
  var goals = [];
  envs.forEach(function(e) {
    if (!e.active && e.active !== undefined) return;
    if (budgetRhythms[e.rhythm]) budgets.push(e);
    else if (e.rhythm === "ongoing" && e.targetCents) goals.push(e);
    else if (e.nextDate && !budgetRhythms[e.rhythm]) bills.push(e);
  });

  // Sort bills by nextDate ascending
  bills.sort(function(a, b) {
    if (a.isDue && !b.isDue) return -1;
    if (!a.isDue && b.isDue) return 1;
    var da = a.daysUntilDue != null ? a.daysUntilDue : 9999;
    var db = b.daysUntilDue != null ? b.daysUntilDue : 9999;
    return da - db;
  });

  // Upcoming: due + upcoming within 7 days
  var due = pic.dueEnvelopes || [];
  var upcoming = (pic.upcomingEnvelopes || []).filter(function(e) {
    return e.daysUntilDue != null && e.daysUntilDue <= 7;
  });
  var upcomingAll = due.concat(upcoming);
  // Deduplicate by key
  var seen = {};
  upcomingAll = upcomingAll.filter(function(e) {
    if (seen[e.key]) return false;
    seen[e.key] = true;
    return true;
  });

  // Transaction groups
  var txGroups = groupTransactionsByDay(pic.transactions);

  return h("div", null,
    // Hero section
    h("div", {
      style: {
        textAlign: "center", padding: "20px 16px 8px", position: "relative",
      },
    },
      h("div", { style: { position: "relative", display: "inline-block" } },
        h(FuelGauge, { ratio: paceRatio, size: 150 }),
        h("div", {
          style: {
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%,-42%)", textAlign: "center",
          },
        },
          h("div", {
            style: Object.assign({}, S.heroValue, { color: paceCol }),
          }, pic.freeRemainingTodayFormatted || sym + "0"),
          h("div", { style: S.heroLabel }, "free today")
        )
      ),
      h("div", {
        style: {
          fontSize: 12, color: C.sub, marginTop: 6,
        },
      }, "Day " + dayOfCycle + " of " + daysInCycle)
    ),

    // Updated timestamp
    props.lastUpdated ? h("div", {
      style: {
        textAlign: "center", fontSize: 11, color: C.muted, marginBottom: 10,
      },
    }, "Updated " + timeAgo(props.lastUpdated)) : null,

    // Upcoming strip
    h(UpcomingStrip, { items: upcomingAll }),

    // Due alerts
    h(DueAlert, { due: due }),

    // Stats row
    h(StatsRow, { pic: pic }),

    // Budgets
    h("div", { style: S.sectionTitle },
      "Budgets",
      budgets.length === 0 ? null : h("span", {
        style: { color: C.muted, fontWeight: 400, marginLeft: 6, textTransform: "none", letterSpacing: 0 },
      }, "(" + budgets.length + ")")
    ),
    budgets.length > 0
      ? budgets.map(function(e) { return h(BudgetCard, { key: e.key, env: e, sym: sym }); })
      : h(EmptyState, { text: "No budgets yet" }),

    // Bills
    h("div", { style: S.sectionTitle },
      "Bills",
      bills.length === 0 ? null : h("span", {
        style: { color: C.muted, fontWeight: 400, marginLeft: 6, textTransform: "none", letterSpacing: 0 },
      }, "(" + bills.length + ")")
    ),
    bills.length > 0
      ? bills.map(function(e) { return h(BillCard, { key: e.key, env: e, sym: sym }); })
      : h(EmptyState, { text: "No bills yet" }),

    // Goals
    goals.length > 0 ? h("div", null,
      h("div", { style: S.sectionTitle },
        "Goals",
        h("span", {
          style: { color: C.muted, fontWeight: 400, marginLeft: 6, textTransform: "none", letterSpacing: 0 },
        }, "(" + goals.length + ")")
      ),
      goals.map(function(e) { return h(GoalCard, { key: e.key, env: e, sym: sym }); })
    ) : null,

    // Transactions
    txGroups.length > 0 ? h("div", null,
      h("div", { style: S.sectionTitle }, "Transactions"),
      txGroups.map(function(g, i) {
        return h(TransactionGroup, { key: g.day || i, group: g, sym: sym });
      })
    ) : h("div", null,
      h("div", { style: S.sectionTitle }, "Transactions"),
      h(EmptyState, { text: "No transactions yet" })
    ),

    // Summary footer
    h(SummaryFooter, { pic: pic })
  );
}

// ── APP ─────────────────────────────────────────────────────────
function App() {
  var picState = useState(null);
  var pic = picState[0], setPic = picState[1];

  var loadingState = useState(true);
  var loading = loadingState[0], setLoading = loadingState[1];

  var errorState = useState(false);
  var error = errorState[0], setError = errorState[1];

  var refreshingState = useState(false);
  var refreshing = refreshingState[0], setRefreshing = refreshingState[1];

  var lastUpdatedState = useState(null);
  var lastUpdated = lastUpdatedState[0], setLastUpdated = lastUpdatedState[1];

  var lastErrState = useState("");
  var lastErr = lastErrState[0], setLastErr = lastErrState[1];

  var sid = useRef(null);
  var scrollRef = useRef(null);

  var loadPicture = useCallback(function(opts) {
    var silent = opts && opts.silent;
    if (!sid.current) return Promise.resolve();

    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setError(false);
    }

    return fetch(API_BASE + "/api/v3/picture/" + sid.current, {
      headers: authHeaders(),
    })
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(d) {
        if (d.pic) {
          setPic(d.pic);
          setLastUpdated(Date.now());
        }
        setError(false);
      })
      .catch(function(err) {
        console.error("[SpendYes] loadPicture error:", err.message);
        setLastErr(err.message);
        if (!pic) setError(true);
      })
      .finally(function() {
        setLoading(false);
        setRefreshing(false);
      });
  }, [pic]);

  // Initial load — retry identity read briefly in case the Telegram SDK
  // populates initDataUnsafe a tick after page load (some clients do).
  useEffect(function() {
    var cancelled = false;
    var attempts = 0;
    var maxAttempts = 6; // ~1.5s total

    function tryStart() {
      if (cancelled) return;
      var tid = window.TELEGRAM_USER_ID;
      var hasInit = !!window.TG_INIT_DATA;
      if ((!tid || tid === "dev") && typeof window.refreshTgIdentity === "function") {
        var snap = window.refreshTgIdentity();
        tid = snap.id || tid;
        hasInit = !!snap.initData;
      }
      if (tid && tid !== "dev") {
        sid.current = "tg_" + tid;
        loadPicture();
        return;
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(tryStart, 250);
        return;
      }
      // Gave up — surface the failure visibly with diagnostics.
      console.error("[SpendYes] No Telegram user ID after " + attempts + " tries. "
        + "platform=" + window.TG_PLATFORM
        + " initData=" + (hasInit ? "present" : "EMPTY"));
      setLastErr("No Telegram identity available.");
      setLoading(false);
      setError(true);
    }
    tryStart();
    return function() { cancelled = true; };
  }, []);

  // Visibility change auto-refresh
  useEffect(function() {
    function onVis() {
      if (!document.hidden && sid.current) {
        loadPicture({ silent: true });
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return function() {
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadPicture]);

  // Pull to refresh
  var pullRefresh = useCallback(function() {
    loadPicture({ silent: true });
  }, [loadPicture]);

  var pullDist = usePullToRefresh(pullRefresh, scrollRef);

  // Render
  var content;
  if (loading && !pic) {
    content = h(Skeleton, null);
  } else if (error && !pic) {
    content = h(ErrorState, { onRetry: function() { loadPicture(); }, errMsg: lastErr });
  } else if (!pic || !pic.setup) {
    content = h(NotSetUpState, null);
  } else {
    content = h(Dashboard, { pic: pic, lastUpdated: lastUpdated });
  }

  return h("div", { style: S.page },
    h(RefreshBar, { show: refreshing }),
    h("div", {
      ref: scrollRef,
      style: Object.assign({}, S.scroll, {
        transform: pullDist > 0 ? "translateY(" + pullDist + "px)" : "none",
        transition: pullDist > 0 ? "none" : "transform 0.3s ease",
      }),
    },
      h(PullIndicator, { dist: pullDist }),
      content
    )
  );
}

// ── MOUNT ───────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById("root")).render(h(App, null));
