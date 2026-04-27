// miniapp/vera-tg.jsx — V3 Mini App
// Envelope-based dashboard + chat. Dark theme. Fuel gauge.
"use strict";

const { useState, useEffect, useRef, useCallback } = React;

const API_BASE = "";
const C = {
  bg: "#0F0F0F", card: "#1A1A1A", border: "#2A2A2A", muted: "#555",
  text: "#E8E4DF", sub: "#999", green: "#4CAF87", amber: "#F0A050",
  red: "#E05555",
};

// ── STYLES ──────────────────────────────────────────────────────
const S = {
  page: { display:"flex", flexDirection:"column", height:"100%", background:C.bg, color:C.text, fontFamily:"'Inter',sans-serif", fontSize:14 },
  tab: { display:"flex", borderBottom:`1px solid ${C.border}`, background:C.bg, flexShrink:0 },
  tabBtn: a => ({ flex:1, padding:"12px 0", background:"none", border:"none", color:a?C.green:C.sub, fontFamily:"'Inter',sans-serif", fontSize:13, fontWeight:a?600:400, cursor:"pointer", borderBottom:a?`2px solid ${C.green}`:"2px solid transparent" }),
  scroll: { flex:1, overflowY:"auto", padding:"16px", WebkitOverflowScrolling:"touch" },
  card: { background:C.card, borderRadius:12, padding:"14px 16px", marginBottom:10, border:`1px solid ${C.border}` },
  row: { display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:4 },
  label: { color:C.sub, fontSize:12, textTransform:"uppercase", letterSpacing:"0.05em" },
  value: { fontSize:20, fontFamily:"'Lora',serif", fontWeight:500 },
  heroValue: { fontSize:36, fontFamily:"'Lora',serif", fontWeight:500, color:C.green, letterSpacing:"-0.02em" },
  heroLabel: { fontSize:13, color:C.sub, marginTop:2 },
  small: { fontSize:13, color:C.sub },
  divider: { height:1, background:C.border, margin:"10px 0" },
  pill: c => ({ display:"inline-block", background:c+"22", color:c, borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:500, marginLeft:6 }),
  chatWrap: { display:"flex", flexDirection:"column", height:"100%" },
  messages: { flex:1, overflowY:"auto", padding:"12px 14px", display:"flex", flexDirection:"column", gap:8, WebkitOverflowScrolling:"touch" },
  bubble: u => ({ maxWidth:"82%", padding:"10px 14px", borderRadius:u?"18px 18px 4px 18px":"18px 18px 18px 4px", background:u?C.green:C.card, color:u?"#fff":C.text, alignSelf:u?"flex-end":"flex-start", fontSize:14, lineHeight:1.45, border:u?"none":`1px solid ${C.border}` }),
  inputRow: { display:"flex", gap:8, padding:"10px 12px", borderTop:`1px solid ${C.border}`, background:C.bg, flexShrink:0 },
  input: { flex:1, background:C.card, border:`1px solid ${C.border}`, borderRadius:22, padding:"10px 16px", color:C.text, fontFamily:"'Inter',sans-serif", fontSize:14, outline:"none", resize:"none", maxHeight:100, lineHeight:1.4 },
  sendBtn: d => ({ width:40, height:40, borderRadius:"50%", border:"none", background:d?C.border:C.green, color:"#fff", fontSize:18, cursor:d?"default":"pointer", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }),
};

function colourFor(ratio) { return ratio >= 0.5 ? C.green : ratio >= 0.2 ? C.amber : C.red; }

// ── FUEL GAUGE ──────────────────────────────────────────────────
function FuelGauge({ ratio, size = 120 }) {
  const r = (size - 12) / 2, cx = size / 2, cy = size / 2;
  const startAngle = 135, endAngle = 405, range = endAngle - startAngle;
  const fillAngle = startAngle + Math.max(0, Math.min(1, ratio)) * range;
  const toRad = a => (a - 90) * Math.PI / 180;
  const arcPath = (start, end) => {
    const s = { x: cx + r * Math.cos(toRad(start)), y: cy + r * Math.sin(toRad(start)) };
    const e = { x: cx + r * Math.cos(toRad(end)), y: cy + r * Math.sin(toRad(end)) };
    const large = (end - start) > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  };
  const col = colourFor(ratio);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path d={arcPath(startAngle, endAngle)} fill="none" stroke={C.border} strokeWidth="8" strokeLinecap="round" />
      {ratio > 0.01 && <path d={arcPath(startAngle, fillAngle)} fill="none" stroke={col} strokeWidth="8" strokeLinecap="round" />}
    </svg>
  );
}

// ── ENVELOPE CARD ───────────────────────────────────────────────
function EnvelopeCard({ env }) {
  const budgetTypes = ["daily","weekly","monthly","on_income"];
  const isBudget = budgetTypes.includes(env.rhythm);
  const isGoal = env.rhythm === "ongoing" && env.targetCents;
  const isBill = env.nextDate && !isBudget;
  let progress = 0, progressLabel = "";
  if (isBudget && env.amountCents > 0) {
    progress = Math.max(0, 1 - (env.spentCents || 0) / env.amountCents);
    progressLabel = env.remainingCents != null ? env.reservedFormatted + " left" : "";
  } else if (isGoal) {
    progress = env.targetCents > 0 ? Math.min(1, (env.fundedCents || 0) / env.targetCents) : 0;
    progressLabel = (env.fundedFormatted || "$0") + " / " + (env.targetFormatted || "$0");
  }
  const col = env.isDue ? C.red : isBudget ? colourFor(progress) : C.green;
  return (
    <div style={S.card}>
      <div style={S.row}>
        <div>
          <span style={{ fontSize:14, fontWeight:500 }}>{env.name}</span>
          <span style={S.pill(col)}>{env.rhythm}{env.isDue ? " • DUE" : ""}</span>
        </div>
        <span style={{ fontSize:15, fontWeight:500, color:col }}>{env.amountFormatted || "$0"}</span>
      </div>
      {(isBudget || isGoal) && (
        <div style={{ marginTop:6 }}>
          <div style={{ height:4, background:C.border, borderRadius:2, overflow:"hidden" }}>
            <div style={{ height:"100%", width:(progress*100)+"%", background:col, borderRadius:2, transition:"width 0.3s" }} />
          </div>
          {progressLabel && <div style={{ ...S.small, marginTop:4 }}>{progressLabel}</div>}
        </div>
      )}
      {isBill && env.nextDate && (
        <div style={{ ...S.small, marginTop:4 }}>
          {env.isDue ? "Overdue" : env.daysUntilDue != null ? `Due in ${env.daysUntilDue}d` : `Next: ${env.nextDate}`}
        </div>
      )}
      {env.spentCents > 0 && !isBudget && <div style={{ ...S.small, marginTop:2 }}>Spent: {env.spentFormatted}</div>}
    </div>
  );
}

// ── DASHBOARD ───────────────────────────────────────────────────
function Dashboard({ pic, loading, onRefresh }) {
  if (loading && !pic) return <div style={{ ...S.scroll, display:"flex", alignItems:"center", justifyContent:"center" }}><div style={{ color:C.sub }}>Loading…</div></div>;
  if (!pic || !pic.setup) return (
    <div style={{ ...S.scroll, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:12 }}>
      <div style={{ fontSize:32 }}>💬</div>
      <div style={{ color:C.sub, textAlign:"center" }}>Say hi in the Chat tab to get started</div>
    </div>
  );
  const freeRatio = pic.balanceCents > 0 ? Math.max(0, pic.freeCents / pic.balanceCents) : 0;
  const envs = pic.envelopes || [];
  const bills = envs.filter(e => e.nextDate && !["daily","weekly","monthly","on_income","ongoing"].includes(e.rhythm));
  const budgets = envs.filter(e => ["daily","weekly","monthly","on_income"].includes(e.rhythm));
  const goals = envs.filter(e => e.rhythm === "ongoing");
  const due = pic.dueEnvelopes || [];
  return (
    <div style={S.scroll}>
      {/* Hero: Fuel gauge + free today */}
      <div style={{ textAlign:"center", marginBottom:16 }}>
        <div style={{ position:"relative", display:"inline-block" }}>
          <FuelGauge ratio={freeRatio} size={140} />
          <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-40%)", textAlign:"center" }}>
            <div style={{ ...S.heroValue, fontSize:28, color:colourFor(freeRatio) }}>{pic.freeRemainingTodayFormatted || "$0"}</div>
            <div style={S.heroLabel}>free today</div>
          </div>
        </div>
      </div>
      {/* Stats row */}
      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
        <div style={{ ...S.card, flex:1, textAlign:"center" }}>
          <div style={S.label}>Daily</div>
          <div style={{ ...S.value, fontSize:16 }}>{pic.dailyPaceFormatted || "$0"}</div>
        </div>
        <div style={{ ...S.card, flex:1, textAlign:"center" }}>
          <div style={S.label}>Balance</div>
          <div style={{ ...S.value, fontSize:16 }}>{pic.balanceFormatted || "$0"}</div>
        </div>
        <div style={{ ...S.card, flex:1, textAlign:"center" }}>
          <div style={S.label}>Days</div>
          <div style={{ ...S.value, fontSize:16 }}>{pic.daysLeft ?? "—"}</div>
        </div>
      </div>
      {/* Due alerts */}
      {due.length > 0 && (
        <div style={{ ...S.card, borderColor:C.red+"66" }}>
          <div style={{ ...S.label, color:C.red, marginBottom:6 }}>Due Now</div>
          {due.map((d,i) => (
            <div key={i} style={{ ...S.row, marginBottom:2 }}>
              <span>{d.name}</span>
              <span style={{ color:C.red, fontWeight:500 }}>{d.amountFormatted || ("$"+(d.amountCents/100).toFixed(0))}</span>
            </div>
          ))}
        </div>
      )}
      {/* Budgets */}
      {budgets.length > 0 && (
        <div>
          <div style={{ ...S.label, marginBottom:8 }}>Budgets</div>
          {budgets.map(e => <EnvelopeCard key={e.key} env={e} />)}
        </div>
      )}
      {/* Bills */}
      {bills.length > 0 && (
        <div>
          <div style={{ ...S.label, marginBottom:8, marginTop:8 }}>Bills</div>
          {bills.map(e => <EnvelopeCard key={e.key} env={e} />)}
        </div>
      )}
      {/* Goals */}
      {goals.length > 0 && (
        <div>
          <div style={{ ...S.label, marginBottom:8, marginTop:8 }}>Goals</div>
          {goals.map(e => <EnvelopeCard key={e.key} env={e} />)}
        </div>
      )}
      {/* Recent transactions */}
      {pic.transactions && pic.transactions.length > 0 && (
        <div style={{ marginTop:12 }}>
          <div style={{ ...S.label, marginBottom:8 }}>Recent</div>
          {pic.transactions.slice(0, 8).map((tx, i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:`1px solid ${C.border}` }}>
              <div>
                <div style={{ fontSize:13 }}>{tx.description || tx.type}</div>
                <div style={{ fontSize:11, color:C.sub }}>{tx.date} · {tx.envelope || "free"}</div>
              </div>
              <div style={{ fontSize:13, fontWeight:500, color: tx.type === "income" ? C.green : tx.type === "refund" ? C.amber : C.text }}>
                {tx.type === "income" ? "+" : tx.type === "refund" ? "+" : "-"}
                {(Math.abs(tx.amountCents)/100).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      )}
      {/* This week/month */}
      <div style={{ ...S.card, marginTop:12 }}>
        <div style={S.row}><span style={S.small}>This week</span><span style={{ fontSize:13 }}>{pic.thisWeekSpentFormatted || "$0"}</span></div>
        <div style={S.row}><span style={S.small}>This month</span><span style={{ fontSize:13 }}>{pic.thisMonthSpentFormatted || "$0"}</span></div>
        {pic.totalSavedCents > 0 && <div style={S.row}><span style={S.small}>Saved</span><span style={{ fontSize:13, color:C.green }}>{pic.totalSavedFormatted || "$0"}</span></div>}
      </div>
    </div>
  );
}

// ── CHAT ────────────────────────────────────────────────────────
function Chat({ sid, onStateUpdate }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);
  const scroll = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:"smooth" }), 50);
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput(""); setSending(true);
    setMessages(m => [...m, { role:"user", text }]);
    scroll();
    try {
      const r = await fetch(`${API_BASE}/api/v3/chat/${sid}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ message: text }),
      });
      const d = await r.json();
      if (d.error) { setMessages(m => [...m, { role:"assistant", text:"Error: " + d.error }]); }
      else {
        setMessages(m => [...m, { role:"assistant", text: d.message || "Got it." }]);
        if (d.pic) onStateUpdate(d.pic);
      }
    } catch (e) { setMessages(m => [...m, { role:"assistant", text:"Connection error." }]); }
    setSending(false); scroll();
  }, [input, sending, sid, onStateUpdate]);
  return (
    <div style={S.chatWrap}>
      <div style={S.messages}>
        {messages.length === 0 && <div style={{ color:C.sub, textAlign:"center", marginTop:40 }}>Say hi to get started</div>}
        {messages.map((m, i) => <div key={i} style={S.bubble(m.role === "user")}>{m.text}</div>)}
        <div ref={bottomRef} />
      </div>
      <div style={S.inputRow}>
        <textarea style={S.input} rows={1} value={input} placeholder="Type a message…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button style={S.sendBtn(sending || !input.trim())} onClick={send} disabled={sending || !input.trim()}>↑</button>
      </div>
    </div>
  );
}

// ── APP ─────────────────────────────────────────────────────────
function App() {
  const [tab, setTab] = useState("dashboard");
  const [pic, setPic] = useState(null);
  const [loading, setLoading] = useState(true);
  const sid = useRef(null);

  // Resolve session ID from Telegram user ID
  useEffect(() => {
    const tid = window.TELEGRAM_USER_ID;
    if (!tid || tid === "dev") {
      // Dev mode: use localStorage token
      let token = null;
      try { token = localStorage.getItem("vera_sid"); } catch {}
      if (!token) { token = "dev_" + Math.random().toString(36).slice(2); try { localStorage.setItem("vera_sid", token); } catch {} }
      sid.current = token;
    } else {
      sid.current = "tg_" + tid;
    }
    loadPicture();
  }, []);

  const loadPicture = async () => {
    if (!sid.current) return;
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/v3/picture/${sid.current}`);
      const d = await r.json();
      if (d.pic) setPic(d.pic);
    } catch {}
    setLoading(false);
  };

  const handleStateUpdate = useCallback((newPic) => {
    setPic(newPic);
  }, []);

  return (
    <div style={S.page}>
      <div style={S.tab}>
        <button style={S.tabBtn(tab === "dashboard")} onClick={() => { setTab("dashboard"); loadPicture(); }}>Dashboard</button>
        <button style={S.tabBtn(tab === "chat")} onClick={() => setTab("chat")}>Chat</button>
      </div>
      {tab === "dashboard"
        ? <Dashboard pic={pic} loading={loading} onRefresh={loadPicture} />
        : <Chat sid={sid.current} onStateUpdate={handleStateUpdate} />
      }
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
