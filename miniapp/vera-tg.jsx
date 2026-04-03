// miniapp/vera-tg.jsx
// Vera Telegram Mini App
// Dark-themed financial dashboard + Vera chat, connected to backend API.
// Loaded inside index.html which sets window.TELEGRAM_USER_ID.

"use strict";

const { useState, useEffect, useRef, useCallback } = React;

// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_BASE = ""; // same origin

// ── THEME ─────────────────────────────────────────────────────────────────────
const C = {
  bg:      "#0F0F0F",
  card:    "#1A1A1A",
  border:  "#2A2A2A",
  muted:   "#555",
  text:    "#E8E4DF",
  sub:     "#999",
  green:   "#4CAF87",
  amber:   "#F0A050",
  red:     "#E05555",
  accent:  "#4CAF87",
};

const S = {
  page: {
    display: "flex", flexDirection: "column", height: "100%",
    background: C.bg, color: C.text, fontFamily: "'Inter', sans-serif",
    fontSize: 14,
  },
  tab: {
    display: "flex", borderBottom: `1px solid ${C.border}`,
    background: C.bg, flexShrink: 0,
  },
  tabBtn: (active) => ({
    flex: 1, padding: "12px 0", background: "none", border: "none",
    color: active ? C.green : C.sub, fontFamily: "'Inter', sans-serif",
    fontSize: 13, fontWeight: active ? 600 : 400, cursor: "pointer",
    borderBottom: active ? `2px solid ${C.green}` : "2px solid transparent",
    transition: "color 0.15s",
  }),
  scroll: {
    flex: 1, overflowY: "auto", padding: "16px",
    WebkitOverflowScrolling: "touch",
  },
  card: {
    background: C.card, borderRadius: 12, padding: "14px 16px",
    marginBottom: 10, border: `1px solid ${C.border}`,
  },
  row: {
    display: "flex", justifyContent: "space-between", alignItems: "baseline",
    marginBottom: 4,
  },
  label: { color: C.sub, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" },
  value: { fontSize: 20, fontFamily: "'Lora', serif", fontWeight: 500 },
  small: { fontSize: 13, color: C.sub },
  heroValue: {
    fontSize: 36, fontFamily: "'Lora', serif", fontWeight: 500,
    color: C.green, letterSpacing: "-0.02em",
  },
  heroLabel: { fontSize: 13, color: C.sub, marginTop: 2 },
  divider: { height: 1, background: C.border, margin: "10px 0" },
  bucket: {
    display: "flex", justifyContent: "space-between",
    padding: "8px 0", borderBottom: `1px solid ${C.border}`,
  },
  bucketLabel: { fontSize: 13, color: C.sub },
  bucketValue: { fontSize: 13, fontWeight: 500 },
  pill: (colour) => ({
    display: "inline-block", background: colour + "22", color: colour,
    borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 500,
  }),
  chatWrap: {
    display: "flex", flexDirection: "column", height: "100%",
  },
  messages: {
    flex: 1, overflowY: "auto", padding: "12px 14px",
    display: "flex", flexDirection: "column", gap: 8,
    WebkitOverflowScrolling: "touch",
  },
  bubble: (isUser) => ({
    maxWidth: "82%", padding: "10px 14px", borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
    background: isUser ? C.green : C.card,
    color: isUser ? "#fff" : C.text,
    alignSelf: isUser ? "flex-end" : "flex-start",
    fontSize: 14, lineHeight: 1.45,
    border: isUser ? "none" : `1px solid ${C.border}`,
  }),
  inputRow: {
    display: "flex", gap: 8, padding: "10px 12px",
    borderTop: `1px solid ${C.border}`, background: C.bg, flexShrink: 0,
  },
  input: {
    flex: 1, background: C.card, border: `1px solid ${C.border}`,
    borderRadius: 22, padding: "10px 16px", color: C.text,
    fontFamily: "'Inter', sans-serif", fontSize: 14, outline: "none",
    resize: "none", maxHeight: 100, lineHeight: 1.4,
  },
  sendBtn: (disabled) => ({
    width: 40, height: 40, borderRadius: "50%", border: "none",
    background: disabled ? C.border : C.green,
    color: "#fff", fontSize: 18, cursor: disabled ? "default" : "pointer",
    flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
    transition: "background 0.15s",
  }),
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmt(usd, rate, sym) {
  if (usd == null) return "—";
  const local = usd * (rate || 1);
  return `${sym || "$"}${Math.round(local).toLocaleString()}`;
}
function fmtUSD(usd) {
  if (usd == null) return "—";
  return `$${Math.abs(usd).toFixed(0)}`;
}
function colourFor(ratio) {
  if (ratio >= 0.5) return C.green;
  if (ratio >= 0.2) return C.amber;
  return C.red;
}

// ── PICTURE PANEL ─────────────────────────────────────────────────────────────
function PicturePanel({ pic, state, loading, onRefresh }) {
  if (loading && !pic) {
    return (
      <div style={{ ...S.scroll, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: C.sub }}>Loading…</div>
      </div>
    );
  }
  if (!pic) {
    return (
      <div style={{ ...S.scroll, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 32 }}>💬</div>
        <div style={{ color: C.sub, textAlign: "center" }}>
          Say hi to Vera in the Chat tab to get started
        </div>
      </div>
    );
  }

  const loc = state?.location || {};
  const rate = loc.localRate || 1;
  const sym  = loc.symbol || "$";
  const f = (u) => fmt(u, rate, sym);

  const daysLeft = pic.daysLeft || 0;
  const freeRatio = pic.trulyFree > 0 ? Math.min(1, (pic.freeToday || 0) / (pic.trulyFree / Math.max(daysLeft, 1))) : 0;
  const freeColour = colourFor(freeRatio);

  return (
    <div style={S.scroll}>
      {/* Hero — Free Today */}
      <div style={{ ...S.card, textAlign: "center", padding: "20px 16px" }}>
        <div style={{ color: C.sub, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
          Free Today
        </div>
        <div style={{ ...S.heroValue, color: freeColour }}>
          {f(pic.freeToday)}
        </div>
        <div style={S.heroLabel}>
          {daysLeft} day{daysLeft !== 1 ? "s" : ""} left in cycle
          {loc.name ? ` · ${loc.flag || ""} ${loc.name}` : ""}
        </div>
        {pic.freeSpentToday > 0 && (
          <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}>
            {f(pic.freeSpentToday)} spent from free pool today
          </div>
        )}
      </div>

      {/* Four Buckets */}
      <div style={S.card}>
        <div style={{ ...S.label, marginBottom: 8 }}>Your Picture</div>

        <div style={S.bucket}>
          <span style={S.bucketLabel}>Bills due this cycle (B1)</span>
          <span style={{ ...S.bucketValue, color: C.red }}>{f(pic.bucket1)}</span>
        </div>
        <div style={S.bucket}>
          <span style={S.bucketLabel}>Planned spending (B2)</span>
          <span style={{ ...S.bucketValue, color: C.amber }}>{f(pic.bucket2)}</span>
        </div>
        <div style={S.bucket}>
          <span style={S.bucketLabel}>Daily envelopes (B3)</span>
          <span style={{ ...S.bucketValue }}>{f(pic.bucket3)}</span>
        </div>
        <div style={{ ...S.bucket, borderBottom: "none" }}>
          <span style={S.bucketLabel}>Truly free (B4)</span>
          <span style={{ ...S.bucketValue, color: freeColour }}>{f(pic.trulyFree)}</span>
        </div>

        <div style={S.divider} />

        <div style={{ ...S.row, marginBottom: 0 }}>
          <span style={{ fontSize: 13, color: C.sub }}>Balance</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{f(pic.confirmedBalance)}</span>
        </div>
        {pic.savings > 0 && (
          <div style={{ ...S.row, marginBottom: 0, marginTop: 4 }}>
            <span style={{ fontSize: 13, color: C.sub }}>Savings</span>
            <span style={{ fontSize: 13, color: C.green }}>{f(pic.savings)}</span>
          </div>
        )}
      </div>

      {/* Envelopes */}
      {pic.computedEnvelopes?.filter(e => e.active).length > 0 && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: 8 }}>Envelopes</div>
          {pic.computedEnvelopes.filter(e => e.active).map((env, i, arr) => {
            const remaining = env.type === "daily" ? (env.dailyLeft ?? env.remainingUSD) : env.remainingUSD;
            const ratio = remaining > 0 && env.allocatedUSD > 0 ? remaining / env.allocatedUSD : 0;
            const c = colourFor(ratio);
            return (
              <div key={i} style={{ ...S.bucket, borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
                <div>
                  <div style={{ fontSize: 13 }}>{env.name}</div>
                  {env.dailyAmountUSD > 0 && (
                    <div style={{ fontSize: 11, color: C.sub }}>
                      {f(env.dailyLeft ?? 0)} left today · {f(env.dailyAmountUSD)}/day
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 13, color: c, fontWeight: 500 }}>{f(remaining)}</div>
                  <div style={{ fontSize: 11, color: C.sub }}>of {f(env.allocatedUSD)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bills */}
      {pic.committedList?.length > 0 && (
        <div style={S.card}>
          <div style={{ ...S.label, marginBottom: 8 }}>Bills</div>
          {pic.committedList.map((b, i) => (
            <div key={i} style={{ ...S.bucket, borderBottom: i < pic.committedList.length - 1 ? `1px solid ${C.border}` : "none" }}>
              <div>
                <div style={{ fontSize: 13 }}>{b.name}</div>
                <div style={{ fontSize: 11, color: C.sub }}>
                  {b.paidThisCycle ? "Paid ✓" : `Due ${b.nextDate || "—"}`}
                </div>
              </div>
              <span style={{ ...S.pill(b.paidThisCycle ? C.green : C.amber) }}>
                {f(b.amountUSD)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Cycle spending summary */}
      {pic.cycleTotal > 0 && (
        <div style={S.card}>
          <div style={{ ...S.row, marginBottom: 0 }}>
            <span style={{ fontSize: 13, color: C.sub }}>Spent this cycle</span>
            <span style={{ fontSize: 13 }}>{f(pic.cycleTotal)}</span>
          </div>
          {pic.savings > 0 && (
            <div style={{ ...S.row, marginBottom: 0, marginTop: 4 }}>
              <span style={{ fontSize: 13, color: C.sub }}>Savings</span>
              <span style={{ fontSize: 13, color: C.green }}>{f(pic.savings)}</span>
            </div>
          )}
        </div>
      )}

      <div style={{ height: 8 }} />

      <button
        onClick={onRefresh}
        style={{
          width: "100%", padding: "12px", border: `1px solid ${C.border}`,
          borderRadius: 10, background: "none", color: C.sub,
          fontFamily: "'Inter', sans-serif", fontSize: 13, cursor: "pointer",
        }}
      >
        Refresh
      </button>
      <div style={{ height: 20 }} />
    </div>
  );
}

// ── CHAT PANEL ────────────────────────────────────────────────────────────────
function ChatPanel({ telegramId, onPicUpdate }) {
  const [msgs, setMsgs] = useState([
    { role: "assistant", text: "Hi! I'm Vera. Tell me what you spent, earned, or ask me anything about your finances." }
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg = { role: "user", text };
    const nextMsgs = [...msgs, userMsg];
    setMsgs(nextMsgs);
    setInput("");
    setSending(true);

    // Resize textarea
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      const apiMsgs = nextMsgs
        .filter(m => m.role !== "assistant" || m !== msgs[0]) // skip system greeting
        .map(m => ({ role: m.role, content: m.text }));

      const res = await fetch(`${API_BASE}/api/vera/${telegramId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMsgs }),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      const reply = data.message + (data.followup ? `\n\n_${data.followup}_` : "");
      setMsgs(m => [...m, { role: "assistant", text: reply }]);

      // Push updated picture up
      if (data.pic && onPicUpdate) onPicUpdate(data.pic, data.state);
    } catch (err) {
      setMsgs(m => [...m, { role: "assistant", text: `Sorry, something went wrong: ${err.message}` }]);
    } finally {
      setSending(false);
    }
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function onInput(e) {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + "px";
  }

  return (
    <div style={S.chatWrap}>
      <div style={S.messages}>
        {msgs.map((m, i) => (
          <div key={i} style={S.bubble(m.role === "user")}>
            {m.text.split("\n").map((line, j) => (
              <span key={j}>
                {line.startsWith("_") && line.endsWith("_")
                  ? <em style={{ color: C.sub, fontSize: 13 }}>{line.slice(1, -1)}</em>
                  : line}
                {j < m.text.split("\n").length - 1 && <br />}
              </span>
            ))}
          </div>
        ))}
        {sending && (
          <div style={{ ...S.bubble(false), color: C.sub }}>
            <span>Vera is thinking</span>
            <span style={{ animation: "blink 1s step-end infinite" }}> …</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={S.inputRow}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={onInput}
          onKeyDown={onKey}
          placeholder="Message Vera…"
          rows={1}
          style={S.input}
          disabled={sending}
        />
        <button onClick={send} disabled={!input.trim() || sending} style={S.sendBtn(!input.trim() || sending)}>
          ↑
        </button>
      </div>
    </div>
  );
}

// ── ROOT APP ──────────────────────────────────────────────────────────────────
function App() {
  const telegramId = window.TELEGRAM_USER_ID || "dev";
  const [tab, setTab] = useState("picture");
  const [pic, setPic] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchPic = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/picture/${telegramId}`);
      const data = await res.json();
      if (data.pic) setPic(data.pic);
      if (data.state) setState(data.state);
    } catch (err) {
      console.error("fetchPic error:", err);
    } finally {
      setLoading(false);
    }
  }, [telegramId]);

  useEffect(() => { fetchPic(); }, [fetchPic]);

  function onPicUpdate(newPic, newState) {
    setPic(newPic);
    if (newState) setState(newState);
  }

  return (
    <div style={S.page}>
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        textarea::placeholder { color: #555; }
        textarea::-webkit-scrollbar { display: none; }
        ::-webkit-scrollbar { width: 0; }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>

      {/* Tabs */}
      <div style={S.tab}>
        <button style={S.tabBtn(tab === "picture")} onClick={() => setTab("picture")}>
          📊 Picture
        </button>
        <button style={S.tabBtn(tab === "chat")} onClick={() => setTab("chat")}>
          💬 Chat
        </button>
      </div>

      {/* Content */}
      {tab === "picture" ? (
        <PicturePanel pic={pic} state={state} loading={loading} onRefresh={fetchPic} />
      ) : (
        <ChatPanel telegramId={telegramId} onPicUpdate={onPicUpdate} />
      )}
    </div>
  );
}

// Mount
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
