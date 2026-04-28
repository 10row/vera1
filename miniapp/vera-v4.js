"use strict";
// SpendYes v4 Mini App. React 18, no JSX, no build step.
// Reads /api/v4/view/:sid. Read-only. All state changes happen in chat.

var h = React.createElement;
var useState = React.useState;
var useEffect = React.useEffect;
var useRef = React.useRef;
var useCallback = React.useCallback;

var API_BASE = "";
var C = {
  bg: "#0F0F0F", card: "#1A1A1A", border: "#2A2A2A", muted: "#555",
  text: "#E8E4DF", sub: "#999", green: "#4CAF87", amber: "#F0A050",
  red: "#E05555",
};

function authHeaders() {
  var initData = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp.initData : "";
  if (!initData && window.TG_INIT_DATA) initData = window.TG_INIT_DATA;
  var headers = { "Content-Type": "application/json" };
  if (initData) headers["X-Telegram-Init-Data"] = initData;
  return headers;
}

function colorForState(s) {
  if (s === "over") return C.red;
  if (s === "tight") return C.amber;
  return C.green;
}

// ── FUEL GAUGE ───────────────────────────────────────────────
function FuelGauge(props) {
  var ratio = Math.max(0, Math.min(1, props.ratio || 0));
  var size = props.size || 150;
  var col = props.color || C.green;
  var r = (size - 14) / 2, cx = size / 2, cy = size / 2;
  var startA = 135, endA = 405;
  var fillA = startA + ratio * (endA - startA);
  function rad(a) { return (a - 90) * Math.PI / 180; }
  function arc(a, b) {
    var sx = cx + r * Math.cos(rad(a)), sy = cy + r * Math.sin(rad(a));
    var ex = cx + r * Math.cos(rad(b)), ey = cy + r * Math.sin(rad(b));
    var large = (b - a) > 180 ? 1 : 0;
    return "M " + sx + " " + sy + " A " + r + " " + r + " 0 " + large + " 1 " + ex + " " + ey;
  }
  return h("svg", { width: size, height: size, viewBox: "0 0 " + size + " " + size },
    h("path", { d: arc(startA, endA), fill: "none", stroke: C.border, strokeWidth: 8, strokeLinecap: "round" }),
    ratio > 0.01 ? h("path", { d: arc(startA, fillA), fill: "none", stroke: col, strokeWidth: 8, strokeLinecap: "round" }) : null
  );
}

// ── COMMON STATES ────────────────────────────────────────────
function Skeleton() {
  var sh = {
    background: "linear-gradient(90deg, " + C.card + " 25%, " + C.border + " 50%, " + C.card + " 75%)",
    backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: 8,
  };
  return h("div", { style: { padding: 24 } },
    h("style", null, "@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }"),
    h("div", { style: Object.assign({}, sh, { width: 150, height: 150, borderRadius: "50%", margin: "20px auto" }) }),
    h("div", { style: Object.assign({}, sh, { height: 60, marginBottom: 12 }) }),
    h("div", { style: Object.assign({}, sh, { height: 60, marginBottom: 12 }) }),
    h("div", { style: Object.assign({}, sh, { height: 60 }) })
  );
}

function statusLabel(s) {
  return ({
    "ok": "Authenticated",
    "no-init-data": "No Telegram session",
    "bad-signature": "Server token mismatch",
    "stale": "Session expired",
    "no-bot-token": "Bot not configured",
    "malformed": "Malformed session",
    "parse-error": "Couldn't read session",
  })[s] || (s || "Unknown");
}

function ErrorState(props) {
  var diagState = useState(null);
  var diag = diagState[0], setDiag = diagState[1];
  var loadState = useState(false);
  var loadingDiag = loadState[0], setLoading = loadState[1];

  function fetchDiag() {
    if (loadingDiag) return;
    setLoading(true); setDiag(null);
    fetch(API_BASE + "/api/v4/whoami", { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(d) { setDiag(d); })
      .catch(function(e) { setDiag({ status: "network", hint: e.message }); })
      .then(function() { setLoading(false); });
  }

  function title() {
    if (!props.errMsg) return "Couldn't load your data";
    if (/identity|telegram/i.test(props.errMsg)) return "We can't see your Telegram identity";
    return "Couldn't load your data";
  }
  function body() {
    if (!props.errMsg) return "Tap retry to try again.";
    if (/identity|telegram/i.test(props.errMsg)) {
      return "Open this Mini App from inside Telegram. Tap the ≡ Dashboard button next to your message box, or send /app to your bot.";
    }
    return "Tap retry to try again.";
  }

  return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, padding: "48px 24px", minHeight: "70vh" } },
    h("div", { style: { width: 64, height: 64, borderRadius: "50%", background: C.card, border: "1px solid " + C.border, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, fontSize: 28, color: C.sub } }, "·  ·"),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 22, fontWeight: 500, textAlign: "center", marginBottom: 10 } }, title()),
    h("div", { style: { color: C.sub, fontSize: 14, lineHeight: 1.5, textAlign: "center", maxWidth: 300, marginBottom: 24 } }, body()),
    h("button", {
      onClick: props.onRetry,
      style: { background: C.green, color: "#fff", border: "none", borderRadius: 10, padding: "12px 28px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "'Inter',sans-serif" },
    }, "Try again"),
    diag === null && !loadingDiag
      ? h("div", { onClick: fetchDiag, style: { marginTop: 28, color: C.muted, fontSize: 12, cursor: "pointer", borderBottom: "1px dotted " + C.muted, paddingBottom: 1 } }, "Diagnostics")
      : null,
    loadingDiag ? h("div", { style: { marginTop: 28, color: C.muted, fontSize: 12 } }, "Checking…") : null,
    diag ? h("div", { style: { marginTop: 24, padding: "14px 16px", maxWidth: 320, width: "100%", background: C.card, border: "1px solid " + C.border, borderRadius: 10, fontSize: 12, lineHeight: 1.5 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } },
        h("div", { style: { width: 8, height: 8, borderRadius: "50%", background: diag.status === "ok" ? C.green : (diag.status === "stale" ? C.amber : C.red) } }),
        h("div", { style: { fontWeight: 600, color: C.text } }, statusLabel(diag.status))
      ),
      diag.hint ? h("div", { style: { color: C.sub } }, diag.hint) : null,
      diag.user ? h("div", { style: { color: C.muted, fontSize: 11, marginTop: 8 } }, "Signed in as " + (diag.user.first_name || "user") + " · id " + diag.user.id) : null
    ) : null
  );
}

function NotSetUpState() {
  return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, padding: "48px 24px", minHeight: "70vh" } },
    h("div", { style: { width: 64, height: 64, borderRadius: "50%", background: C.card, border: "1px solid " + C.border, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, fontSize: 28 } }, "👋"),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 22, fontWeight: 500, textAlign: "center", marginBottom: 10 } }, "Welcome"),
    h("div", { style: { color: C.sub, fontSize: 14, lineHeight: 1.5, textAlign: "center", maxWidth: 300 } }, "Send your bot a message — your starting balance, when you get paid, any bills. Your dashboard fills in from there.")
  );
}

// ── DASHBOARD ────────────────────────────────────────────────
function Dashboard(props) {
  var v = props.view;
  var sym = v.currencySymbol || "$";
  var col = colorForState(v.state);

  // Hero ratio: dailyPace as a fraction of disposable / daysToPayday baseline.
  // Show full when green, partial as state degrades. For simplicity: ratio = todayRemaining / dailyPace.
  var ratio = v.dailyPaceCents > 0 ? Math.max(0, Math.min(1, v.todayRemainingCents / v.dailyPaceCents)) : 0;

  // Group envelopes by kind
  var envs = v.envelopes || [];
  var bills = envs.filter(function(e) { return e.kind === "bill"; });
  var budgets = envs.filter(function(e) { return e.kind === "budget"; });
  var goals = envs.filter(function(e) { return e.kind === "goal"; });

  var hero;
  if (v.state === "over") {
    hero = h("div", { style: { textAlign: "center" } },
      h("div", { style: { fontSize: 13, color: C.sub, marginBottom: 4 } }, "Over for this period"),
      h("div", { style: { fontFamily: "'Lora',serif", fontSize: 38, fontWeight: 500, color: C.red, lineHeight: 1.1 } }, v.deficitFormatted),
      h("div", { style: { fontSize: 12, color: C.sub, marginTop: 8 } }, v.daysToPayday + " days to payday")
    );
  } else {
    hero = h("div", { style: { textAlign: "center", padding: "20px 16px 8px" } },
      h("div", { style: { position: "relative", display: "inline-block" } },
        h(FuelGauge, { ratio: ratio, color: col, size: 160 }),
        h("div", { style: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center" } },
          h("div", { style: { fontFamily: "'Lora',serif", fontSize: 32, fontWeight: 500, color: col } }, v.todayRemainingFormatted),
          h("div", { style: { fontSize: 11, color: C.sub, marginTop: 4 } }, "free today")
        )
      ),
      h("div", { style: { fontSize: 12, color: C.sub, marginTop: 10 } },
        v.dailyPaceFormatted + "/day · " + v.daysToPayday + " days left")
    );
  }

  return h("div", null,
    hero,
    // Stats row
    h("div", { style: { display: "flex", gap: 8, padding: "12px 16px" } },
      Stat({ label: "Balance", value: v.balanceFormatted }),
      Stat({ label: "Reserved", value: v.obligatedFormatted }),
      Stat({ label: "Disposable", value: v.disposableFormatted })
    ),
    // Due now
    v.dueNow && v.dueNow.length > 0 ? Section({ title: "Due now",
      children: v.dueNow.map(function(d) {
        return h("div", { key: d.key, style: cardStyle() },
          h("div", null,
            h("div", { style: { fontWeight: 500 } }, d.name),
            h("div", { style: { fontSize: 11, color: C.sub } }, d.dueDate)
          ),
          h("div", { style: { color: C.amber, fontWeight: 500 } }, d.amountFormatted)
        );
      }),
    }) : null,
    // Upcoming
    v.upcoming && v.upcoming.length > 0 ? Section({ title: "Upcoming",
      children: v.upcoming.map(function(u) {
        return h("div", { key: u.key, style: cardStyle() },
          h("div", null,
            h("div", { style: { fontWeight: 500 } }, u.name),
            h("div", { style: { fontSize: 11, color: C.sub } }, "in " + u.daysUntilDue + " days")
          ),
          h("div", { style: { color: C.text } }, u.amountFormatted)
        );
      }),
    }) : null,
    // Bills
    bills.length > 0 ? Section({ title: "Bills",
      children: bills.map(function(e) { return EnvelopeRow(e); }),
    }) : null,
    // Budgets
    budgets.length > 0 ? Section({ title: "Budgets",
      children: budgets.map(function(e) { return EnvelopeRow(e); }),
    }) : null,
    // Goals
    goals.length > 0 ? Section({ title: "Goals",
      children: goals.map(function(e) { return EnvelopeRow(e); }),
    }) : null,
    // Footer note
    h("div", { style: { textAlign: "center", padding: "24px 16px 32px", color: C.muted, fontSize: 11 } },
      "Read-only view. Send your bot a message to make changes.")
  );
}

function Stat(props) {
  return h("div", { style: { flex: 1, background: C.card, border: "1px solid " + C.border, borderRadius: 10, padding: "10px 12px" } },
    h("div", { style: { fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.06em" } }, props.label),
    h("div", { style: { fontFamily: "'Lora',serif", fontSize: 16, marginTop: 4 } }, props.value)
  );
}

function Section(props) {
  return h("div", null,
    h("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, padding: "20px 16px 8px" } }, props.title),
    h("div", { style: { padding: "0 16px" } }, props.children)
  );
}

function cardStyle() {
  return {
    background: C.card, border: "1px solid " + C.border, borderRadius: 10,
    padding: "12px 14px", marginBottom: 8,
    display: "flex", justifyContent: "space-between", alignItems: "center",
  };
}

function EnvelopeRow(e) {
  return h("div", { key: e.key, style: cardStyle() },
    h("div", null,
      h("div", { style: { fontWeight: 500 } }, e.name),
      h("div", { style: { fontSize: 11, color: C.sub, marginTop: 2 } },
        e.kind === "bill" && e.dueDate ? "due " + e.dueDate :
        e.kind === "goal" && e.targetCents ? "target" :
        "spent " + e.spentFormatted
      )
    ),
    h("div", { style: { fontFamily: "'Lora',serif" } }, e.amountFormatted)
  );
}

// ── APP ──────────────────────────────────────────────────────
function App() {
  var viewState = useState(null);
  var view = viewState[0], setView = viewState[1];
  var loadingState = useState(true);
  var loading = loadingState[0], setLoading = loadingState[1];
  var errorState = useState(false);
  var error = errorState[0], setError = errorState[1];
  var lastErrState = useState("");
  var lastErr = lastErrState[0], setLastErr = lastErrState[1];

  var sid = useRef(null);

  var loadView = useCallback(function() {
    if (!sid.current) return;
    setLoading(true); setError(false);
    fetch(API_BASE + "/api/v4/view/" + sid.current, { headers: authHeaders() })
      .then(function(r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function(d) {
        setView(d.view || { setup: false });
        setError(false);
      })
      .catch(function(e) {
        console.error("[v4] view error:", e.message);
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

  // Auto-refresh on visibility change
  useEffect(function() {
    function onVis() { if (!document.hidden && sid.current) loadView(); }
    document.addEventListener("visibilitychange", onVis);
    return function() { document.removeEventListener("visibilitychange", onVis); };
  }, [loadView]);

  var content;
  if (loading && !view) content = h(Skeleton, null);
  else if (error && !view) content = h(ErrorState, { onRetry: loadView, errMsg: lastErr });
  else if (!view || !view.setup) content = h(NotSetUpState, null);
  else content = h(Dashboard, { view: view });

  return h("div", {
    style: {
      display: "flex", flexDirection: "column", minHeight: "100vh",
      background: C.bg, color: C.text, fontFamily: "'Inter',sans-serif", fontSize: 14,
    },
  }, content);
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App, null));
