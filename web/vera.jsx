const { useState, useEffect, useRef, useCallback } = React;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VERA — Financial Clarity App
// Architecture version 2.0 — name-keyed entities, upsert writes, four-bucket model
//
// PORTING TO REPLIT/BACKEND:
//   State maps directly to 5 database tables:
//     ledger      → append-only rows (userId, id, type, date, amountUSD, ...)
//     committed   → upsert by (userId, name)
//     envelopes   → upsert by (userId, name)
//     cycle       → one row per user (payday, start, expectedIncomeUSD, savingRate)
//     location    → one row per user (spendCurrency, symbol, localRate, flag, name)
//   applyAction() → database writes
//   computePicture() → database reads + computation
//   No other changes needed to port.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500&display=swap";
document.head.appendChild(fontLink);

// ── TIME ─────────────────────────────────────────────────────────────────────
const NOW = () => new Date();
const TODAY = () => NOW().toISOString().split("T")[0];
const TIME_CONTEXT = () => {
  const n = NOW();
  return {
    date: TODAY(),
    weekday: n.toLocaleDateString("en-US", { weekday: "long" }),
    month: n.toLocaleString("en-US", { month: "long" }),
    year: n.getFullYear(),
    dayOfMonth: n.getDate(),
    display: n.toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" }),
  };
};
const daysUntil = (ds) => {
  if (!ds) return 30;
  return Math.max(0, Math.ceil((new Date(ds+"T00:00:00") - new Date(TODAY()+"T00:00:00")) / 86400000));
};
const uid = () => Math.random().toString(36).slice(2,9);

// ── TAXONOMY ─────────────────────────────────────────────────────────────────
const TAXONOMY = {
  food_drink:    { label:"Food & Drink",          icon:"🍽", subs:{ groceries:{label:"Groceries",kw:["supermarket","grocery","lotus","big c","tops","7-eleven","convenience store","minimart","fruit","water"]}, cafes:{label:"Cafes",kw:["coffee","café","cafe","latte","espresso","americano","cappuccino","brunch"]}, restaurants:{label:"Restaurants",kw:["restaurant","dinner","lunch","dining","sushi","pizza","burger","takeaway","delivery","grab food","foodpanda","meal","ate out"]}, bars:{label:"Bars & Drinks",kw:["bar","beer","wine","cocktail","drinks out","pub","whiskey"]}, meal_plan:{label:"Meal Plan",kw:["meal plan","meal prep","meal subscription"]} }},
  transport:     { label:"Transport",             icon:"🚗", subs:{ rideshare:{label:"Rideshare",kw:["grab","bolt","uber","taxi","tuk tuk","motorbike taxi"]}, public:{label:"Public Transport",kw:["bts","mrt","metro","bus","subway","train","sky train","ferry"]}, flights:{label:"Flights",kw:["flight","airfare","airline","airasia","flying","plane ticket","airport"]}, fuel:{label:"Fuel",kw:["fuel","petrol","gas station","ptt","shell"]} }},
  home:          { label:"Home & Living",         icon:"🏠", subs:{ rent:{label:"Rent",kw:["rent","monthly rent","accommodation","apartment","condo","serviced apartment"]}, utilities:{label:"Utilities",kw:["electric","electricity","water bill","internet","wifi","utility","true","ais","dtac","phone bill","mobile bill"]}, laundry:{label:"Laundry",kw:["laundry","dry cleaning","wash","laundromat"]}, supplies:{label:"Home Supplies",kw:["cleaning","household","detergent","toilet paper","home supplies"]} }},
  health_body:   { label:"Health & Body",         icon:"💪", subs:{ gym:{label:"Gym & Fitness",kw:["gym","fitness","membership","crossfit","muay thai","yoga","pilates","personal trainer","boxing"]}, supplements:{label:"Supplements",kw:["protein","supplements","vitamins","creatine","pre-workout","whey","supplement"]}, medical:{label:"Medical",kw:["doctor","hospital","clinic","dentist","pharmacy","medicine","prescription","consultation","checkup"]}, grooming:{label:"Grooming",kw:["haircut","barber","hair salon","massage","spa","facial","grooming"]} }},
  clothing:      { label:"Clothing & Style",      icon:"👕", subs:{ activewear:{label:"Activewear",kw:["gym clothes","activewear","sports clothes","running shoes","trainers","workout clothes","nike","adidas"]}, everyday:{label:"Everyday Clothing",kw:["clothes","shirt","trousers","jeans","dress","shoes","sneakers","clothing","outfit"]} }},
  work_business: { label:"Work & Business",       icon:"💼", subs:{ software:{label:"Software & Subs",kw:["anthropic","claude","cursor","github","notion","figma","slack","zoom","adobe","software","subscription","saas","replit","openai","chatgpt","linear","vercel"]}, equipment:{label:"Equipment",kw:["laptop","computer","monitor","keyboard","mouse","equipment","tech","electronics","phone","iphone","macbook"]}, coworking:{label:"Coworking",kw:["coworking","co-working","office space","hot desk","wework"]} }},
  entertainment: { label:"Entertainment",         icon:"🎭", subs:{ streaming:{label:"Streaming & Media",kw:["netflix","spotify","apple music","youtube premium","disney","hbo","streaming","music subscription"]}, events:{label:"Events",kw:["concert","event","show","museum","cinema","movie","theatre","ticket","activity","tour"]}, hobbies:{label:"Hobbies",kw:["hobby","craft","instrument","music gear","cello","guitar","piano"]} }},
  education:     { label:"Education & Growth",    icon:"📚", subs:{ courses:{label:"Courses",kw:["course","udemy","coursera","class","workshop","training","bootcamp","online learning"]}, books:{label:"Books",kw:["book","kindle","audible","reading","textbook","bookshop"]} }},
  travel:        { label:"Travel",                icon:"✈️", subs:{ accommodation:{label:"Accommodation",kw:["hotel","hostel","airbnb","booking.com","agoda","resort"]}, visas:{label:"Visas & Docs",kw:["visa","visa fee","immigration","passport","border","extension","work permit","embassy"]} }},
  financial:     { label:"Financial",             icon:"💰", subs:{ investment:{label:"Investment",kw:["invest","investment","stocks","shares","crypto","bitcoin","trading","portfolio","etf"]}, fees:{label:"Bank Fees",kw:["bank fee","transfer fee","atm fee","foreign transaction","exchange fee","wise","swift"]} }},
  other:         { label:"Other",                 icon:"📦", subs:{ uncategorised:{label:"Uncategorised",kw:[]} }},
};

function mapCategory(description, customSubs = []) {
  const desc = description.toLowerCase();
  const matches = (text, kw) => kw.includes(" ") ? text.includes(kw) : new RegExp(`(?<![a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?![a-z])`,"i").test(text);
  let best = null, bestScore = 0;
  for (const cs of customSubs) {
    if (!cs.active) continue;
    const score = (cs.keywords||[]).filter(kw => matches(desc,kw)).length;
    if (score > 0 && score >= bestScore) { bestScore = score; best = { parentId: cs.parentId, subId: cs.id, label: cs.label, isCustom: true }; }
  }
  for (const [pid, parent] of Object.entries(TAXONOMY)) {
    if (pid === "other") continue;
    for (const [sid, sub] of Object.entries(parent.subs)) {
      const score = sub.kw.filter(kw => matches(desc,kw)).length;
      if (score > bestScore) { bestScore = score; best = { parentId: pid, subId: sid, label: sub.label, isCustom: false }; }
    }
  }
  if (!best) return { parentId:"other", subId:"uncategorised" };
  return best;
}

// ── DISPLAY UTILS ─────────────────────────────────────────────────────────────
const fmtUSD = (usd, d=0) => {
  const abs = Math.abs(usd||0);
  const str = d > 0 ? abs.toFixed(d) : abs < 10 ? abs.toFixed(1) : Math.round(abs).toString();
  return `${(usd||0) < 0 ? "-" : ""}$${str.replace(/\B(?=(\d{3})+(?!\d))/g,",")}`;
};
const fmtLocal = (usd, rate=35, symbol="฿") => {
  const local = (usd||0) * rate;
  const abs = Math.abs(local);
  return `${(usd||0) < 0 ? "-" : ""}${symbol}${Math.round(abs).toString().replace(/\B(?=(\d{3})+(?!\d))/g,",")}`;
};
const fmtDual = (usd, rate=35, symbol="฿") => ({ usd: fmtUSD(usd), local: fmtLocal(usd, rate, symbol) });

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STATE SHAPE v2
// All mutations go through applyAction() — never mutate state directly.
//
// committed: { [name]: { name, amountUSD, frequency, nextDate, autoPay, paidThisCycle, active, parkedForNextCycle } }
// envelopes: { [name]: { name, type, allocatedUSD, dailyAmountUSD, linkedParentId, linkedSubIds, reserveFromPool, rollover, resetOnIncome, active } }
// ledger: [ { id, type, ts, date, amountUSD, ... } ]   — append only, never mutated
// cycle: { start, payday, expectedIncomeUSD, savingRate }
// location: { spendCurrency, symbol, localRate, name, flag, rateUpdated }
// savings: number   — accumulated from income events
// lastDiff: string  — what changed last action, shown to Vera next turn
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const INITIAL_STATE = {
  setup: false,
  pendingSetup: null,
  committed: {},     // keyed by name — upsert by name, no ids, no duplicates
  envelopes: {},     // keyed by name — upsert by name
  ledger: [],
  cycle: null,
  location: { spendCurrency:"THB", symbol:"฿", localRate:35, name:"Thailand", flag:"🇹🇭", rateUpdated:null },
  savings: 0,
  lastDiff: null,
  customSubs: [],
};

// ── LEDGER HELPERS ────────────────────────────────────────────────────────────
const mkEntry = (type, data) => ({ id:uid(), type, ts:NOW().toISOString(), date:TODAY(), ...data });

const confirmedBalanceFromLedger = (ledger) => ledger.reduce((sum, e) => {
  if (e.type === "setup")       return e.amountUSD || 0;
  if (e.type === "income")      return sum + (e.amountUSD || 0);
  if (e.type === "transaction") return sum - (e.amountUSD || 0);
  if (e.type === "correction")  return e.amountUSD || 0;
  return sum;
}, 0);

// ── COMMITTED DATE ADVANCE ────────────────────────────────────────────────────
const advanceDate = (dateStr, frequency) => {
  if (!dateStr) return dateStr;
  const dt = new Date(dateStr+"T00:00:00");
  const tod = new Date(TODAY()+"T00:00:00");
  while (dt < tod) {
    if (frequency === "monthly") dt.setMonth(dt.getMonth()+1);
    else if (frequency === "weekly") dt.setDate(dt.getDate()+7);
    else if (frequency === "annual") dt.setFullYear(dt.getFullYear()+1);
    else break;
  }
  return dt.toISOString().split("T")[0];
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// APPLY ACTION — single entry point for all state mutations
// Every action is idempotent where possible.
// Name-keyed upserts prevent duplicates by construction.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function applyAction(state, action) {
  if (!action || action.type === "none") return state;
  const d = action.data || {};
  const s = {
    ...state,
    ledger: [...state.ledger],
    committed: {...state.committed},
    envelopes: {...state.envelopes},
    customSubs: [...(state.customSubs||[])],
  };

  switch (action.type) {

    // ── PROPOSE / CONFIRM / CANCEL SETUP ─────────────────────────────────────
    case "propose_setup": {
      s.pendingSetup = { ...d, proposedAt: TODAY() };
      break;
    }
    case "confirm_setup": {
      if (!s.pendingSetup) break;
      return applyAction({ ...s, pendingSetup: null }, { type: "complete_setup", data: s.pendingSetup });
    }
    case "cancel_setup": {
      s.pendingSetup = null;
      break;
    }

    // ── COMPLETE SETUP — atomic, everything in one action ─────────────────────
    case "complete_setup": {
      const daysLeft = d.payday ? Math.max(1, daysUntil(d.payday)) : 30;

      // Location
      if (d.localRate) s.location = { spendCurrency: d.spendCurrency||"THB", symbol: d.spendSymbol||"฿", localRate: d.localRate, name: d.location||"Thailand", flag: d.locationFlag||"🇹🇭", rateUpdated: TODAY() };

      // Ledger — opening balance + any initial transactions
      const setupEntry = mkEntry("setup", { amountUSD: d.balanceUSD||0, note:"Initial setup" });
      const txEntries = (d.transactions||[]).map(t => mkEntry("transaction", {
        description: t.description, amountUSD: t.amountUSD,
        localAmount: t.localAmount||null, localCurrency: t.localCurrency||null,
        parentId: t.parentId||"other", subId: t.subId||"uncategorised",
        date: t.date||TODAY(),
      }));
      s.ledger = [setupEntry, ...txEntries];

      // Committed — upsert by name, advance past dates
      s.committed = {};
      for (const c of (d.committed||[])) {
        const name = c.name.toLowerCase();
        const freq = c.frequency||"monthly";
        s.committed[name] = {
          name: c.name, amountUSD: c.amountUSD||0,
          frequency: freq,
          nextDate: advanceDate(c.nextDate, freq),
          autoPay: c.autoPay||false,
          paidThisCycle: false, active: true, parkedForNextCycle: false,
        };
      }

      // Envelopes — upsert by name, compute daily cycle totals
      s.envelopes = {};
      for (const e of (d.envelopes||[])) {
        const name = e.name.toLowerCase();
        const allocatedUSD = e.type === "daily" && e.dailyAmountUSD
          ? e.dailyAmountUSD * daysLeft
          : (e.allocatedUSD||0);
        s.envelopes[name] = {
          name: e.name, type: e.type||"monthly",
          allocatedUSD,
          dailyAmountUSD: e.type === "daily" ? (e.dailyAmountUSD||e.allocatedUSD) : null,
          linkedParentId: e.linkedParentId||null,
          linkedSubIds: e.linkedSubIds||null,
          reserveFromPool: e.type === "daily" ? false : true,
          rollover: false, resetOnIncome: true, active: true,
        };
      }

      s.cycle = { start: TODAY(), payday: d.payday, expectedIncomeUSD: d.expectedIncomeUSD||0, savingRate: d.savingRate||0.10 };
      s.savings = 0;
      s.setup = true;
      s.lastDiff = `Setup complete. Balance $${(d.balanceUSD||0).toFixed(2)}, payday ${d.payday}.`;
      break;
    }

    // ── TRANSACTION ───────────────────────────────────────────────────────────
    case "transaction": {
      const prev = confirmedBalanceFromLedger(s.ledger);
      s.ledger = [...s.ledger, mkEntry("transaction", {
        description: d.description, amountUSD: d.amountUSD,
        localAmount: d.localAmount||null, localCurrency: d.localCurrency||null,
        parentId: d.parentId||"other", subId: d.subId||"uncategorised",
        date: d.date||TODAY(),
      })];
      s.lastDiff = `Transaction: ${d.description} $${(d.amountUSD||0).toFixed(2)}${d.localAmount?` (${d.localCurrency||""}${d.localAmount})`:""}`;
      break;
    }

    // ── INCOME — cycle advance, envelope reset ────────────────────────────────
    case "income": {
      const savingUSD = (d.amountUSD||0) * (s.cycle?.savingRate||0.10);
      const net = (d.amountUSD||0) - savingUSD;
      s.savings = (s.savings||0) + savingUSD;

      // Last cycle spend per category
      const cycleStart = s.cycle?.start || TODAY();
      const lastCycleSpend = {};
      s.ledger.filter(e => e.type==="transaction" && e.date >= cycleStart).forEach(e => {
        const pid = e.parentId||"other";
        lastCycleSpend[pid] = (lastCycleSpend[pid]||0) + (e.amountUSD||0);
      });

      s.ledger = [...s.ledger, mkEntry("income", {
        amountUSD: net, grossAmountUSD: d.amountUSD, savingUSD,
        description: d.description||"Income", date: d.date||TODAY(),
      })];

      const newPayday = d.nextPayday || s.cycle?.payday;
      const newDaysLeft = newPayday ? Math.max(1, daysUntil(newPayday)) : 30;
      s.cycle = { start: TODAY(), payday: newPayday, expectedIncomeUSD: d.expectedIncomeUSD||s.cycle?.expectedIncomeUSD, savingRate: s.cycle?.savingRate||0.10 };

      // Advance committed dates, deactivate once items
      for (const name of Object.keys(s.committed)) {
        const c = s.committed[name];
        if (!c.active) continue;
        if (c.parkedForNextCycle) { s.committed[name] = { ...c, parkedForNextCycle: false, active: true }; continue; }
        if (c.frequency === "once" && c.nextDate <= TODAY()) { s.committed[name] = { ...c, active: false }; continue; }
        if (c.frequency !== "once") { s.committed[name] = { ...c, paidThisCycle: false, nextDate: advanceDate(c.nextDate, c.frequency) }; }
      }

      // Reset/rollover envelopes
      for (const name of Object.keys(s.envelopes)) {
        const env = s.envelopes[name];
        if (!env.active || !env.resetOnIncome) continue;
        const spent = s.ledger.filter(e => {
          if (e.type !== "transaction" || e.date < cycleStart) return false;
          if (env.linkedParentId) return e.parentId === env.linkedParentId;
          return false;
        }).reduce((sum, e) => sum + (e.amountUSD||0), 0);
        const unused = Math.max(0, (env.allocatedUSD||0) - spent);
        const rolledOver = env.rollover ? unused : 0;
        const newAllocated = env.type === "daily" && env.dailyAmountUSD
          ? env.dailyAmountUSD * newDaysLeft
          : (env.allocatedUSD||0);
        s.envelopes[name] = { ...env, allocatedUSD: newAllocated + rolledOver };
      }

      s.lastDiff = `Income $${net.toFixed(2)} landed ($${savingUSD.toFixed(2)} to savings). Last cycle spend: ${Object.entries(lastCycleSpend).map(([k,v])=>`${k}:$${v.toFixed(2)}`).join(", ")||"nothing"}.`;
      break;
    }

    // ── CORRECTION — absolute balance reset ───────────────────────────────────
    case "correction": {
      s.ledger = [...s.ledger, mkEntry("correction", { amountUSD: d.amountUSD, note: d.note||"Balance correction" })];
      s.lastDiff = `Balance corrected to $${(d.amountUSD||0).toFixed(2)}.`;
      break;
    }

    // ── SET_COMMITTED — upsert by name, no duplicates possible ───────────────
    // This is the ONLY way to create or update a committed item.
    // Name is the key. If it exists, update. If not, create. Impossible to duplicate.
    case "set_committed": {
      const name = (d.name||"").toLowerCase();
      if (!name) break;
      const existing = s.committed[name];
      const freq = d.frequency || existing?.frequency || "monthly";
      const nextDate = d.nextDate
        ? advanceDate(d.nextDate, freq)
        : (existing?.nextDate || TODAY());
      const prev = existing ? `$${existing.amountUSD}` : "new";
      s.committed[name] = {
        name: d.name || existing?.name || d.name,
        amountUSD: d.amountUSD ?? existing?.amountUSD ?? 0,
        frequency: freq,
        nextDate,
        autoPay: d.autoPay ?? existing?.autoPay ?? false,
        paidThisCycle: d.paidThisCycle ?? existing?.paidThisCycle ?? false,
        active: d.active ?? existing?.active ?? true,
        parkedForNextCycle: d.parkedForNextCycle ?? existing?.parkedForNextCycle ?? false,
      };
      s.lastDiff = existing
        ? `Updated ${d.name}: ${prev} → $${(d.amountUSD||existing.amountUSD).toFixed(2)}`
        : `Added ${d.name}: $${(d.amountUSD||0).toFixed(2)} ${freq}`;
      break;
    }

    // ── REMOVE_COMMITTED ──────────────────────────────────────────────────────
    case "remove_committed": {
      const name = (d.name||"").toLowerCase();
      if (s.committed[name]) {
        s.committed[name] = { ...s.committed[name], active: false };
        s.lastDiff = `Removed ${d.name}.`;
      }
      break;
    }

    // ── CONFIRM_PAYMENT ───────────────────────────────────────────────────────
    case "confirm_payment": {
      const name = (d.name||"").toLowerCase();
      if (s.committed[name]) {
        s.committed[name] = { ...s.committed[name], paidThisCycle: true };
        s.lastDiff = `${d.name} marked as paid this cycle.`;
      }
      break;
    }

    // ── SET_ENVELOPE — upsert by name, no duplicates possible ────────────────
    // Name is the key. If it exists, update. If not, create.
    case "set_envelope": {
      const name = (d.name||"").toLowerCase();
      if (!name) break;
      const existing = s.envelopes[name];
      const type = d.type || existing?.type || "monthly";
      const daysLeft = s.cycle?.payday ? Math.max(1, daysUntil(s.cycle.payday)) : 30;
      const allocatedUSD = type === "daily" && d.dailyAmountUSD
        ? d.dailyAmountUSD * daysLeft
        : (d.allocatedUSD ?? existing?.allocatedUSD ?? 0);
      const prev = existing ? `$${existing.allocatedUSD?.toFixed(2)}` : "new";
      s.envelopes[name] = {
        name: d.name || existing?.name,
        type,
        allocatedUSD,
        dailyAmountUSD: type === "daily" ? (d.dailyAmountUSD || existing?.dailyAmountUSD || null) : null,
        linkedParentId: d.linkedParentId ?? existing?.linkedParentId ?? null,
        linkedSubIds: d.linkedSubIds ?? existing?.linkedSubIds ?? null,
        reserveFromPool: type === "daily" ? false : (d.reserveFromPool ?? existing?.reserveFromPool ?? true),
        rollover: d.rollover ?? existing?.rollover ?? false,
        resetOnIncome: d.resetOnIncome ?? existing?.resetOnIncome ?? true,
        active: d.active ?? existing?.active ?? true,
      };
      s.lastDiff = existing
        ? `Updated ${d.name} envelope: ${prev} → $${allocatedUSD.toFixed(2)}`
        : `Added ${d.name} envelope: $${allocatedUSD.toFixed(2)} ${type}`;
      break;
    }

    // ── REMOVE_ENVELOPE ───────────────────────────────────────────────────────
    case "remove_envelope": {
      const name = (d.name||"").toLowerCase();
      if (s.envelopes[name]) {
        s.envelopes[name] = { ...s.envelopes[name], active: false };
        s.lastDiff = `Removed ${d.name} envelope.`;
      }
      break;
    }

    // ── SET_LOCATION ──────────────────────────────────────────────────────────
    case "set_location": {
      const prev = s.location.localRate;
      s.location = {
        spendCurrency: d.spendCurrency || s.location.spendCurrency,
        symbol: d.spendSymbol || s.location.symbol,
        localRate: d.localRate || s.location.localRate,
        name: d.location || s.location.name,
        flag: d.locationFlag || s.location.flag,
        rateUpdated: TODAY(),
      };
      s.lastDiff = d.localRate && d.localRate !== prev
        ? `Rate updated ${s.location.symbol}${prev}/$ → ${s.location.symbol}${d.localRate}/$`
        : `Location updated to ${s.location.name}`;
      break;
    }

    // ── SET_SAVING_RATE ───────────────────────────────────────────────────────
    case "set_saving_rate": {
      if (s.cycle) s.cycle = { ...s.cycle, savingRate: d.rate };
      s.lastDiff = `Saving rate set to ${((d.rate||0.1)*100).toFixed(0)}%`;
      break;
    }

    // ── CREATE_CUSTOM_SUB ─────────────────────────────────────────────────────
    case "create_custom_sub": {
      s.customSubs = [...s.customSubs, { id:uid(), parentId:d.parentId, label:d.label, keywords:d.keywords||[], active:true }];
      break;
    }

    default: break;
  }
  return s;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COMPUTE PICTURE — pure function, never stored, always fresh
// Four buckets always sum to confirmedBalance.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function computePicture(state) {
  const today = TODAY();
  const { ledger, committed, envelopes, cycle, location, savings, customSubs } = state;
  const rate = location?.localRate || 35;
  const symbol = location?.symbol || "฿";
  const payday = cycle?.payday;
  const cycleStart = cycle?.start || today;
  const daysLeft = payday ? daysUntil(payday) : 30;

  // ── BALANCE ───────────────────────────────────────────────────────────────
  const confirmedBalance = confirmedBalanceFromLedger(ledger);

  // ── BUCKET 1: Bills due — committed items due before payday ──────────────
  const committedList = Object.values(committed||{}).filter(c => c.active && !c.parkedForNextCycle);
  const upcomingCommitted = committedList.filter(c => {
    if (!c.nextDate || c.paidThisCycle) return false;
    if (c.frequency === "once" && c.nextDate < today) return false;
    return c.nextDate >= today && (!payday || c.nextDate <= payday);
  });
  const bucket1 = upcomingCommitted.reduce((s, c) => s + (c.amountUSD||0), 0);

  // Auto-confirm auto-pay items past due
  const autoPayPast = committedList.filter(c => c.autoPay && c.nextDate && c.nextDate < today && !c.paidThisCycle);

  // Stale = manual, unpaid, past due
  const staleCommitted = committedList.filter(c => !c.autoPay && !c.paidThisCycle && c.nextDate && c.nextDate < today);

  // Imminent = due within 3 days
  const imminentBills = upcomingCommitted.filter(c => daysUntil(c.nextDate) <= 3);

  // ── ENVELOPES — compute spent per envelope ────────────────────────────────
  const envelopeList = Object.values(envelopes||{}).filter(e => e.active);
  const computedEnvelopes = envelopeList.map(env => {
    const matchesTx = (e) => {
      if (e.type !== "transaction" || e.date < cycleStart) return false;
      if (env.linkedSubIds?.length) return e.parentId === env.linkedParentId && env.linkedSubIds.includes(e.subId);
      if (env.linkedParentId) return e.parentId === env.linkedParentId;
      return false;
    };
    const spentTotal = ledger.filter(matchesTx).reduce((s,e) => s+(e.amountUSD||0), 0);
    const spentBeforeToday = ledger.filter(e => matchesTx(e) && e.date < today).reduce((s,e) => s+(e.amountUSD||0), 0);
    const spentToday = ledger.filter(e => matchesTx(e) && e.date === today).reduce((s,e) => s+(e.amountUSD||0), 0);
    const remaining = Math.max(0, (env.allocatedUSD||0) - spentTotal);
    let dailyLeft = null;
    if (env.type === "daily" && daysLeft > 0) {
      const remainingBeforeToday = Math.max(0, (env.allocatedUSD||0) - spentBeforeToday);
      const dailyTarget = remainingBeforeToday / daysLeft;
      dailyLeft = Math.max(0, dailyTarget - spentToday);
    }
    return { ...env, spentUSD: spentTotal, spentToday, remainingUSD: remaining, dailyLeft };
  });

  // ── BUCKET 2: Planned spending — non-daily envelopes that reserve pool ────
  const bucket2 = computedEnvelopes
    .filter(e => e.reserveFromPool && e.type !== "daily")
    .reduce((s, env) => s + Math.max(0, (env.allocatedUSD||0) - (env.spentUSD||0)), 0);

  // ── BUCKET 3: Daily allowances — cycle remaining ──────────────────────────
  const bucket3 = computedEnvelopes
    .filter(e => e.type === "daily")
    .reduce((s, e) => s + (e.remainingUSD||0), 0);

  // ── BUCKET 4: Truly free ──────────────────────────────────────────────────
  const trulyFree = confirmedBalance - bucket1 - bucket2 - bucket3;

  // Free pool spend today = transactions today not matched by any envelope
  const freeSpentToday = ledger.filter(e =>
    e.type === "transaction" && e.date === today &&
    !computedEnvelopes.some(env => {
      if (env.linkedSubIds?.length) return e.parentId === env.linkedParentId && env.linkedSubIds.includes(e.subId);
      if (env.linkedParentId) return e.parentId === env.linkedParentId;
      return false;
    })
  ).reduce((s,e) => s+(e.amountUSD||0), 0);
  // Mirror food envelope logic: (start-of-day trulyFree / daysLeft) - spent today from free pool
  const freeTodayTarget = daysLeft > 0 ? Math.max(0, trulyFree + freeSpentToday) / daysLeft : 0;
  const freeToday = Math.max(0, freeTodayTarget - freeSpentToday);
  const totalReserved = bucket1 + bucket2 + bucket3;

  // ── CATEGORY SPEND ────────────────────────────────────────────────────────
  const categorySpend = {};
  const subSpend = {};
  ledger.filter(e => e.type === "transaction" && e.date >= cycleStart).forEach(e => {
    const pid = e.parentId||"other";
    const sid = e.subId||"uncategorised";
    categorySpend[pid] = (categorySpend[pid]||0) + (e.amountUSD||0);
    if (!subSpend[pid]) subSpend[pid] = {};
    subSpend[pid][sid] = (subSpend[pid][sid]||0) + (e.amountUSD||0);
  });

  const categoryRows = Object.entries(categorySpend).map(([parentId, spent]) => {
    const tax = TAXONOMY[parentId];
    const env = computedEnvelopes.find(e => e.linkedParentId === parentId && !e.linkedSubIds?.length);
    const allocated = env?.allocatedUSD || 0;
    const remaining = allocated > 0 ? Math.max(0, allocated - spent) : null;
    const pct = allocated > 0 ? Math.min(100, spent/allocated*100) : 0;
    const subs = Object.entries(subSpend[parentId]||{}).map(([subId,amt]) => ({
      subId, label: tax?.subs?.[subId]?.label||subId, amount: amt
    })).sort((a,b) => b.amount - a.amount);
    return { parentId, label:tax?.label||parentId, icon:tax?.icon||"•", spent, allocated, remaining, pct, env, subs };
  }).sort((a,b) => b.spent - a.spent);

  // ── CASHFLOW TIMELINE ─────────────────────────────────────────────────────
  const timeline = [];
  let runningBal = confirmedBalance;
  [...upcomingCommitted].sort((a,b) => a.nextDate.localeCompare(b.nextDate)).forEach(c => {
    runningBal -= (c.amountUSD||0);
    timeline.push({ type:"bill", date:c.nextDate, name:c.name, amount:c.amountUSD||0, balanceAfter:runningBal, frequency:c.frequency, autoPay:c.autoPay });
  });
  if (payday) {
    const gross = cycle?.expectedIncomeUSD||0;
    const saving = gross * (cycle?.savingRate||0.10);
    timeline.push({ type:"payday", date:payday, name:"Payday", gross, saving, net:gross-saving, balanceAfter:runningBal+gross-saving });
  }

  // ── ENVELOPE ROWS for Today view ─────────────────────────────────────────
  const envelopeRows = computedEnvelopes.map(env => {
    const tax = TAXONOMY[env.linkedParentId];
    const effectiveAllocated = env.allocatedUSD||0;
    const pct = effectiveAllocated > 0 ? Math.min(100, (env.spentUSD||0)/effectiveAllocated*100) : 0;
    return {
      name: env.name, type: env.type,
      icon: tax?.icon||"💊", parentLabel: tax?.label||env.linkedParentId||"",
      cycleSpend: env.spentUSD||0, allocated: effectiveAllocated,
      remaining: env.remainingUSD||0, pct,
      dailyLeft: env.dailyLeft,
      spentToday: env.spentToday||0,
      isOver: (env.spentUSD||0) > effectiveAllocated,
      reserveFromPool: env.reserveFromPool,
    };
  });

  const hasFoodEnvelope = computedEnvelopes.some(e => e.linkedParentId === "food_drink" && e.type === "daily");

  // ── PREVIOUS CYCLE SUMMARY ────────────────────────────────────────────────
  const incomeEvents = ledger.filter(e => e.type === "income" || e.type === "setup");
  let prevCycleSpend = null;
  if (incomeEvents.length >= 2) {
    const prevCycleStart = incomeEvents[incomeEvents.length - 2].date;
    const prevTx = ledger.filter(e => e.type === "transaction" && e.date >= prevCycleStart && e.date < cycleStart);
    const prevTotal = prevTx.reduce((s,e) => s+(e.amountUSD||0), 0);
    const prevByCategory = {};
    prevTx.forEach(e => { const pid = e.parentId||"other"; prevByCategory[pid]=(prevByCategory[pid]||0)+(e.amountUSD||0); });
    prevCycleSpend = { total: prevTotal, byCategory: prevByCategory };
  }

  // ── CURRENT CYCLE TOTAL SPEND ─────────────────────────────────────────────
  const cycleTx = ledger.filter(e => e.type === "transaction" && e.date >= cycleStart);
  const cycleTotal = cycleTx.reduce((s,e) => s+(e.amountUSD||0), 0);

  return {
    today, payday, daysLeft, rate, symbol,
    spendCurrency: location?.spendCurrency||"THB",
    location: location?.name||"Thailand",
    locationFlag: location?.flag||"🇹🇭",
    confirmedBalance, savings,
    bucket1, bucket2, bucket3, trulyFree, totalReserved,
    freeToday, freeTodayTarget, freeSpentToday,
    upcomingCommitted, imminentBills, staleCommitted,
    computedEnvelopes, envelopeRows, hasFoodEnvelope,
    categoryRows, timeline,
    committedList,
    prevCycleSpend, cycleTotal,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VERA AI — context-aware, always reads from computed picture
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function askVera(messages, state, onChunk) {
  const tc = TIME_CONTEXT();
  const pic = computePicture(state);
  const sym = state.location?.symbol||"฿";
  const rate = state.location?.localRate||35;

  const buildPicture = () => {
    if (!state.setup) return "Setup not complete.";
    const committedTable = state.committedList?.length
      ? Object.values(state.committed||{}).filter(c=>c.active&&!c.parkedForNextCycle)
          .map(c=>`  "${c.name}" | $${(c.amountUSD||0).toFixed(2)} | ${c.frequency} | next:${c.nextDate}${c.paidThisCycle?" [PAID]":""}${c.autoPay?" [AUTO]":""}`)
          .join("\n")
      : "  (none)";
    const envTable = Object.values(state.envelopes||{}).filter(e=>e.active)
      .map(e=>{
        const ce = pic.computedEnvelopes?.find(x=>x.name===e.name);
        return `  "${e.name}" | ${e.type} | $${(e.allocatedUSD||0).toFixed(2)}${e.dailyAmountUSD?` ($${e.dailyAmountUSD}/day)`:""} | spent:$${(ce?.spentUSD||0).toFixed(2)} | left today:$${(ce?.dailyLeft??ce?.remainingUSD??0).toFixed(2)} | reserves:${e.reserveFromPool?"yes":"no"}`;
      }).join("\n") || "  (none)";
    return `TODAY: ${tc.display}
FOUR BUCKETS (always sum to balance $${pic.confirmedBalance.toFixed(2)}):
  1. Bills due:        $${pic.bucket1.toFixed(2)}  ${pic.upcomingCommitted.map(c=>c.name).join(", ")||"none"}
  2. Planned spending: $${pic.bucket2.toFixed(2)}  ${Object.values(state.envelopes||{}).filter(e=>e.active&&e.reserveFromPool&&e.type!=="daily").map(e=>e.name).join(", ")||"none"}
  3. Daily allowances: $${pic.bucket3.toFixed(2)}  ${Object.values(state.envelopes||{}).filter(e=>e.active&&e.type==="daily").map(e=>e.name).join(", ")||"none"}
  4. Truly free:       $${pic.trulyFree.toFixed(2)} ($${pic.freeToday.toFixed(2)} remaining today)
Savings: $${(state.savings||0).toFixed(2)} | Payday: ${pic.payday||"not set"} (${pic.daysLeft}d) | Rate: ${sym}${rate}/$ | ${state.location?.name||""}

DAILY ALLOWANCES TODAY:
${pic.envelopeRows.filter(e=>e.type==="daily").map(e=>`  ${e.name}: $${(e.dailyLeft||0).toFixed(2)} left today (${sym}${Math.round((e.dailyLeft||0)*rate)} | spent today: $${(e.spentToday||0).toFixed(2)})`).join("\n")||"  none set"}

COMMITTED ITEMS (upsert by name — use exact name in set_committed):
${committedTable}

ENVELOPES (upsert by name — use exact name in set_envelope):
${envTable}

FREE TODAY: $${pic.freeToday.toFixed(2)} remaining today${pic.freeSpentToday>0?` ($${pic.freeSpentToday.toFixed(2)} spent from free pool today, $${pic.freeTodayTarget.toFixed(2)}/day target)`:` ($${pic.freeTodayTarget.toFixed(2)}/day)`}
THIS CYCLE SPEND: $${(pic.cycleTotal||0).toFixed(2)} total${Object.entries(pic.categoryRows?.reduce((a,r)=>({...a,[r.parentId]:r.spent}),{})||{}).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>" | "+k+":$"+v.toFixed(0)).join("")}
${pic.prevCycleSpend?`LAST CYCLE: $${pic.prevCycleSpend.total.toFixed(2)} total${Object.entries(pic.prevCycleSpend.byCategory).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>" | "+k+":$"+v.toFixed(0)).join("")}`:""}
UPCOMING BILLS: ${pic.upcomingCommitted.map(c=>`"${c.name}" $${(c.amountUSD||0).toFixed(2)} due ${c.nextDate}${c.nextDate===pic.today?" TODAY":""}`).join(", ")||"none"}
PARKED NEXT CYCLE: ${Object.values(state.committed||{}).filter(c=>c.parkedForNextCycle).map(c=>`"${c.name}" $${(c.amountUSD||0).toFixed(2)}`).join(", ")||"none"}
RECENT: ${state.ledger.slice(-5).map(e=>`[${e.date}] ${e.type} ${e.description||""} ${e.amountUSD!=null?"$"+e.amountUSD.toFixed(2):""}${e.localAmount?` (${e.localCurrency||""}${e.localAmount})`:""} ${e.parentId&&e.parentId!=="other"?"["+e.parentId+"]":""}`).join(" | ")||"empty"}
${state.lastDiff ? `LAST ACTION RESULT: ${state.lastDiff} ✓` : ""}`;
  };

  const system = `CRITICAL: Respond ONLY with a single JSON object. Nothing outside it.
{"message":"...","action":{"type":"none","data":{}},"action2":null,"followup":null}
Multiple actions: {"message":"...","actions":[...],"followup":null}
No *, **, #, bullets, markdown in message. Plain sentences only.

YOU ARE VERA — sharp, warm, direct. Smart friend who knows the numbers. Never filler openers.
Today: ${tc.date} (${tc.weekday} ${tc.month} ${tc.dayOfMonth} ${tc.year})

${buildPicture()}

═══ SETUP ═══
Opening: "Hey, I'm Vera. Tell me your situation — balance, when you get paid, what's coming out."
Extract everything from one message. Defaults: ${sym}${rate}/$ ${state.location?.name||"Thailand"}, 10% saving, rollover off.
Fire propose_setup with ALL data. Keep message to 1 line: "Got it — review the summary."
On "yes/good/confirm": fire confirm_setup {}.
On "fix X": fire cancel_setup, listen, propose_setup again.

propose_setup / complete_setup data:
{ balanceUSD, payday:"YYYY-MM-DD", expectedIncomeUSD, savingRate:0.10,
  localRate, spendCurrency, spendSymbol, location, locationFlag,
  committed:[{name,amountUSD,frequency,nextDate,autoPay}],
  envelopes:[{name,type:"daily"|"monthly"|"project",dailyAmountUSD(daily) OR allocatedUSD(monthly),linkedParentId,reserveFromPool}],
  transactions:[{description,amountUSD,localAmount,localCurrency,parentId,subId,date}] }
Code auto-advances past nextDates. Daily envelopes: pass dailyAmountUSD, code × daysLeft.

═══ ACTIONS ═══
propose_setup / confirm_setup / cancel_setup / complete_setup
transaction: {description,amountUSD,localAmount,localCurrency,parentId,subId,date}
income: {amountUSD,description,date,nextPayday,expectedIncomeUSD}
correction: {amountUSD,note}
set_committed: {name,amountUSD,frequency,nextDate,autoPay,parkedForNextCycle}  ← UPSERT BY NAME
remove_committed: {name}
confirm_payment: {name}
set_envelope: {name,type,dailyAmountUSD OR allocatedUSD,linkedParentId,reserveFromPool,rollover}  ← UPSERT BY NAME
remove_envelope: {name}
set_location: {localRate,spendCurrency,spendSymbol,location,locationFlag}
set_saving_rate: {rate}
create_custom_sub: {parentId,label,keywords:[]}

═══ CRITICAL RULES ═══
NAMES ARE THE KEY. set_committed and set_envelope use name to find the item. Use exact name always.
No ids needed. No add vs update decision. Just set_committed/set_envelope with the name.
NEVER add a new committed item for something that already exists — use set_committed with the same name.
NEVER recalculate numbers — read from picture exactly. FREE TODAY = $${pic.freeToday.toFixed(2)} remaining today.
After food transaction: report food left today from DAILY ALLOWANCES above.
After any set_committed or set_envelope: confirm what changed from LAST ACTION RESULT next turn.
Location change: only THB amounts change, USD amounts stay the same.
"Paid X" → transaction + confirm_payment {name:"X"}.
"X is due" → set_committed only. No transaction.
Supplements/planned purchase → set_envelope type:"monthly" reserveFromPool:true.
Daily food → set_envelope type:"daily" dailyAmountUSD:X linkedParentId:"food_drink".

EVERY transaction MUST have parentId + subId. NEVER use "other"/"uncategorised" unless truly nothing fits.
TAXONOMY (parentId → subId):
food_drink → cafes(coffee,juice,smoothies,drinks out), groceries, restaurants, bars, meal_plan
transport → rideshare, public, flights, fuel
home → rent, utilities, laundry, supplies
health_body → gym, supplements, medical, grooming
clothing → activewear, everyday
work_business → software, equipment, coworking
entertainment → streaming, events, hobbies
education → courses, books
travel → accommodation, visas
financial → investment, fees

═══ EDGE CASES ═══
REIMBURSEMENTS — "I paid for a friend / covering someone":
→ Log full amount normally, add "(owe me)" to description. Tell user: "Logged. When they pay you back, just say '[name] paid me back $X'."
→ When repaid: correction { amountUSD: confirmedBalance + repaidAmount, note: "Reimbursement from X" }

SPLIT EXPENSES — "split X with friend / split 3 ways":
→ Calculate user's share only. "Split 900 baht 3 ways" → amountUSD: 300/rate. description: "Dinner (my third)"
→ Default to 50/50 if not specified.

RECURRING PURCHASES (supplements, toiletries, gear bought regularly):
→ Log the transaction normally.
→ If amount > $20 and not in any envelope, ask once: "Want me to set aside $X/month for [thing] so it doesn't surprise your free pool next cycle?"
→ If yes: set_envelope type:"monthly" allocatedUSD:X reserveFromPool:true

BALANCE DRIFT — "something seems off / balance looks wrong":
→ "Check your bank app — what's the actual balance showing?" Then: correction { amountUSD: [bank balance], note: "Verified against bank" }
→ Don't guess. Don't recalculate. Just correct to what the bank says.

IRREGULAR INCOME — no fixed payday:
→ Still works. Default daysLeft is 30 when no payday set.
→ After income lands: "When do you roughly expect the next one?" Set payday from their answer.
→ If truly unknown: set payday 30 days out as placeholder. Revisit when income arrives.

MULTIPLE ITEMS IN ONE MESSAGE:
→ "protein $45, creatine $20, vitamins $15" → three separate transactions, all health_body:supplements
→ "coffee and juice 200 baht" → one transaction, food_drink:cafes, total 200 baht converted

INCOME:
→ After income fires, use followup to recap last cycle: total spent, top 2-3 categories, and new cycle reset.
→ Reference THIS CYCLE SPEND and LAST CYCLE from picture for accurate numbers.
→ Keep it to 2-3 lines. Debrief tone, not report tone.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": window.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 900,
      system,
      messages: messages.map(m => ({ role:m.role, content:m.content })),
      stream: true,
    }),
  });

  if (!res.ok) { const b = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status}: ${b.slice(0,200)}`); }

  let full = "";
  const reader = res.body.getReader(), dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    for (const line of dec.decode(value).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim(); if (raw === "[DONE]") continue;
      try { const ev = JSON.parse(raw); if (ev.type==="content_block_delta"&&ev.delta?.text) { full+=ev.delta.text; const m=full.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/); if(m){try{onChunk(m[1].replace(/\\n/g,"\n").replace(/\\"/g,'"').replace(/\\\\/g,"\\"));}catch{}} } } catch {}
    }
  }
  const cleaned = full.trim().replace(/^```(?:json)?\s*/m,"").replace(/\s*```$/m,"").trim();
  try { return JSON.parse(cleaned); }
  catch { const m = cleaned.match(/\{[\s\S]*\}/); if(m){try{return JSON.parse(m[0]);}catch{}} return {message:cleaned||"Got it.",action:{type:"none",data:{}},followup:null}; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DESIGN TOKENS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const T = {
  bg:"#f9f7f4", surface:"#ffffff", border:"#e8e4de", borderLight:"#f0ece6",
  text:"#1a1917", textSub:"#6b6560", textMuted:"#a8a29c",
  accent:"#c96442", accentBg:"#fdf1ec", accentBorder:"#f0c4b4",
  green:"#4a7c59", greenBg:"#edf5f0",
  serif:"'Lora', serif", sans:"'Inter', sans-serif",
};

// ── UI COMPONENTS ─────────────────────────────────────────────────────────────
function Amt({ usd, rate, symbol="฿", size="mid" }) {
  const color = (usd||0) < 0 ? T.accent : T.text;
  const d = fmtDual(usd, rate, symbol);
  if (size==="hero") return <div><div style={{fontFamily:T.serif,fontSize:52,fontWeight:400,color,lineHeight:1}}>{d.usd}</div><div style={{fontFamily:T.sans,fontSize:13,color:T.textMuted,marginTop:4,fontWeight:300}}>{d.local}</div></div>;
  if (size==="large") return <div><div style={{fontFamily:T.serif,fontSize:30,color,lineHeight:1}}>{d.usd}</div><div style={{fontFamily:T.sans,fontSize:11,color:T.textMuted,marginTop:2,fontWeight:300}}>{d.local}</div></div>;
  if (size==="mid") return <div style={{textAlign:"right"}}><div style={{fontFamily:T.serif,fontSize:18,color}}>{d.usd}</div><div style={{fontFamily:T.sans,fontSize:10,color:T.textMuted,marginTop:1,fontWeight:300}}>{d.local}</div></div>;
  return <span style={{fontFamily:T.serif,fontSize:13,color}}>{d.usd} <span style={{fontFamily:T.sans,fontSize:10,color:T.textMuted,fontWeight:300}}>{d.local}</span></span>;
}

function Card({ children, style={} }) { return <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:16,...style}}>{children}</div>; }
function Label({ children }) { return <div style={{fontSize:10,fontFamily:T.sans,fontWeight:500,letterSpacing:"0.1em",textTransform:"uppercase",color:T.textMuted,marginBottom:12}}>{children}</div>; }

function LocationPill({ location, onTap }) {
  const stale = !location?.rateUpdated;
  return (
    <div onClick={onTap} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",borderRadius:20,background:stale?"#fdf1ec":"#f0f7f3",border:`1px solid ${stale?"#f0c4b4":"#c8e0d0"}`,cursor:"pointer"}}>
      <span style={{fontSize:12}}>{location?.flag||"🌍"}</span>
      <span style={{fontSize:10,fontFamily:T.sans,fontWeight:500,color:stale?T.accent:T.green,letterSpacing:"0.04em"}}>
        {location?.spendCurrency||"THB"} · {location?.symbol||"฿"}{location?.localRate||35}/$
      </span>
    </div>
  );
}

function SetupConfirmCard({ data, location, onConfirm, onEdit }) {
  const daysLeft = data.payday ? Math.max(1,daysUntil(data.payday)) : 30;
  const sym = data.spendSymbol || location?.symbol || "฿";
  const r = data.localRate || location?.localRate || 35;
  const f = (usd) => `$${(usd||0).toFixed(0)}`;
  const fl = (usd) => `${sym}${Math.round((usd||0)*r).toLocaleString()}`;
  const foodEnv = (data.envelopes||[]).find(e=>e.type==="daily");

  return (
    <div style={{background:T.surface,border:`2px solid ${T.accent}`,borderRadius:18,padding:"20px",marginBottom:16}}>
      <div style={{fontSize:11,fontFamily:T.sans,fontWeight:600,letterSpacing:"0.1em",textTransform:"uppercase",color:T.accent,marginBottom:14}}>Review your setup</div>
      {[
        ["Balance", `${f(data.balanceUSD)} · ${fl(data.balanceUSD)}`],
        ["Payday", `${data.payday} (${daysLeft} days)`],
        ["Income", data.expectedIncomeUSD ? `${f(data.expectedIncomeUSD)} · ${fl(data.expectedIncomeUSD)}` : "—"],
        ["Saving", `${((data.savingRate||0.10)*100).toFixed(0)}%`],
        ["Rate", `${sym}${r}/$ · ${data.location||""} ${data.locationFlag||""}`],
      ].map(([label,value]) => (
        <div key={label} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.borderLight}`}}>
          <span style={{fontSize:12,color:T.textMuted,fontFamily:T.sans}}>{label}</span>
          <span style={{fontSize:12,fontFamily:T.serif,color:T.text}}>{value}</span>
        </div>
      ))}
      {(data.committed||[]).length > 0 && (
        <div style={{marginTop:10}}>
          <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>Bills</div>
          {(data.committed||[]).map((c,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${T.borderLight}`}}>
              <span style={{fontSize:12,color:T.text,fontFamily:T.sans}}>{c.name} <span style={{color:T.textMuted,fontSize:10}}>{c.frequency}</span></span>
              <span style={{fontSize:12,fontFamily:T.serif,color:T.accent}}>{f(c.amountUSD)} · {fl(c.amountUSD)}</span>
            </div>
          ))}
        </div>
      )}
      {foodEnv && (
        <div style={{marginTop:10,padding:"8px 12px",background:T.greenBg,borderRadius:10}}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:12,color:T.green,fontFamily:T.sans}}>🍽 Food {foodEnv.dailyAmountUSD?`$${foodEnv.dailyAmountUSD}/day`:""}</span>
            <span style={{fontSize:12,fontFamily:T.serif,color:T.green}}>${((foodEnv.dailyAmountUSD||0)*daysLeft).toFixed(0)} this cycle</span>
          </div>
        </div>
      )}
      {(data.transactions||[]).length > 0 && (
        <div style={{marginTop:10}}>
          <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:4}}>Already spent today</div>
          {(data.transactions||[]).map((t,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0"}}>
              <span style={{fontSize:12,color:T.text,fontFamily:T.sans}}>{t.description}</span>
              <span style={{fontSize:12,fontFamily:T.serif,color:T.textSub}}>${(t.amountUSD||0).toFixed(2)}{t.localAmount?` · ${sym}${t.localAmount}`:""}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{display:"flex",gap:10,marginTop:16}}>
        <button onClick={onConfirm} style={{flex:2,padding:"11px 0",background:T.accent,color:"#fff",border:"none",borderRadius:12,fontFamily:T.sans,fontSize:13,fontWeight:500,cursor:"pointer"}}>Looks good — let's go</button>
        <button onClick={onEdit} style={{flex:1,padding:"11px 0",background:T.accentBg,color:T.accent,border:`1px solid ${T.accentBorder}`,borderRadius:12,fontFamily:T.sans,fontSize:13,cursor:"pointer"}}>Fix something</button>
      </div>
    </div>
  );
}

// ── VERA PORTAL ───────────────────────────────────────────────────────────────
function VeraPortal({ open, onOpen, onClose, hasAlert, lastReply, msgs, stream, loading, input, setInput, onSend, onKeyDown, inputRef, chatRef }) {
  const containerRef = useRef(null);
  const posRef = useRef({x:0,y:0});
  const dragging = useRef(false);
  const didDrag = useRef(false);
  const startMouse = useRef({x:0,y:0});
  const startPos = useRef({x:0,y:0});
  const [btnPos, setBtnPos] = useState({x:0,y:0});
  const [mounted, setMounted] = useState(false);

  useEffect(()=>{
    const root = containerRef.current?.closest("[data-vera-root]");
    const w = root?.offsetWidth||480, h = root?.offsetHeight||window.innerHeight;
    posRef.current = {x:w-72,y:h-140}; setBtnPos({x:w-72,y:h-140});
    requestAnimationFrame(()=>setMounted(true));
  },[]);

  const onMouseDown = useCallback((e)=>{ if(open)return; dragging.current=true; didDrag.current=false; startMouse.current={x:e.clientX,y:e.clientY}; startPos.current={...posRef.current}; e.preventDefault(); },[open]);
  const onTouchStart = useCallback((e)=>{ if(open)return; const t=e.touches[0]; dragging.current=true; didDrag.current=false; startMouse.current={x:t.clientX,y:t.clientY}; startPos.current={...posRef.current}; },[open]);

  useEffect(()=>{
    const move=(cx,cy)=>{ if(!dragging.current)return; const dx=cx-startMouse.current.x,dy=cy-startMouse.current.y; if(Math.abs(dx)>4||Math.abs(dy)>4)didDrag.current=true; const root=containerRef.current?.closest("[data-vera-root]"); const maxX=(root?.offsetWidth||480)-60,maxY=(root?.offsetHeight||window.innerHeight)-60; const nx=Math.max(8,Math.min(maxX,startPos.current.x+dx)),ny=Math.max(80,Math.min(maxY,startPos.current.y+dy)); posRef.current={x:nx,y:ny}; setBtnPos({x:nx,y:ny}); };
    const up=()=>{dragging.current=false;};
    const mm=e=>move(e.clientX,e.clientY); const tm=e=>{const t=e.touches[0];move(t.clientX,t.clientY);};
    window.addEventListener("mousemove",mm); window.addEventListener("mouseup",up);
    window.addEventListener("touchmove",tm,{passive:true}); window.addEventListener("touchend",up);
    return()=>{ window.removeEventListener("mousemove",mm); window.removeEventListener("mouseup",up); window.removeEventListener("touchmove",tm); window.removeEventListener("touchend",up); };
  },[]);

  const handleClick=()=>{ if(!didDrag.current) open?onClose():onOpen(); };
  const bubble=(r)=>({ maxWidth:"82%", alignSelf:r==="user"?"flex-end":"flex-start", background:r==="user"?T.accentBg:T.surface, border:`1px solid ${r==="user"?T.accentBorder:T.border}`, borderRadius:r==="user"?"16px 16px 4px 16px":"16px 16px 16px 4px", padding:"10px 14px", fontSize:14, lineHeight:1.65, color:r==="user"?"#7a3020":T.text, whiteSpace:"pre-wrap", fontFamily:T.sans, fontWeight:300 });
  const TRANS="left 0.32s cubic-bezier(0.32,0.72,0,1),top 0.32s cubic-bezier(0.32,0.72,0,1),width 0.32s cubic-bezier(0.32,0.72,0,1),height 0.32s cubic-bezier(0.32,0.72,0,1),border-radius 0.32s cubic-bezier(0.32,0.72,0,1),box-shadow 0.32s ease";
  const root=containerRef.current?.closest("[data-vera-root]");
  const rootH=root?.offsetHeight||window.innerHeight;
  const drawerH=rootH*0.72;

  const style=open?{position:"absolute",left:0,top:rootH-drawerH,width:"100%",height:drawerH,borderRadius:"24px 24px 0 0",background:T.surface,boxShadow:"0 -8px 40px rgba(0,0,0,0.12)",zIndex:70,cursor:"default",transition:TRANS,overflow:"hidden",display:"flex",flexDirection:"column"}
  :{position:"absolute",left:btnPos.x,top:btnPos.y,width:52,height:52,borderRadius:"50%",background:T.accent,boxShadow:"0 4px 20px rgba(201,100,66,0.35)",zIndex:60,cursor:"grab",transition:TRANS,overflow:"hidden",userSelect:"none",WebkitUserSelect:"none",opacity:mounted?1:0};

  return (
    <>
      {open&&<div onClick={onClose} style={{position:"absolute",inset:0,zIndex:65,background:"rgba(26,25,23,0.28)",backdropFilter:"blur(3px)"}}/>}
      <div ref={containerRef} onMouseDown={onMouseDown} onTouchStart={onTouchStart} onClick={handleClick} style={style}>
        {!open&&(
          <div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
            <span style={{fontFamily:T.serif,fontStyle:"italic",fontSize:18,color:"#fff"}}>v</span>
            {hasAlert&&<div style={{position:"absolute",top:6,right:6,width:9,height:9,borderRadius:"50%",background:"#fff",border:`2px solid ${T.accent}`}}/>}
            {lastReply&&<div style={{position:"absolute",bottom:"calc(100% + 10px)",right:0,maxWidth:220,background:T.surface,border:`1px solid ${T.border}`,borderRadius:"14px 14px 4px 14px",padding:"8px 12px",fontSize:12,color:T.textSub,fontFamily:T.sans,lineHeight:1.5,boxShadow:"0 4px 16px rgba(0,0,0,0.07)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",pointerEvents:"none"}}>{lastReply.length>60?lastReply.slice(0,60)+"…":lastReply}</div>}
          </div>
        )}
        {open&&(
          <div style={{display:"flex",flexDirection:"column",height:"100%"}} onClick={e=>e.stopPropagation()}>
            <div style={{padding:"12px 20px 10px",borderBottom:`1px solid ${T.borderLight}`,flexShrink:0}}>
              <div style={{width:36,height:4,borderRadius:2,background:T.border,margin:"0 auto 12px"}}/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:28,height:28,borderRadius:"50%",background:T.accent,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontFamily:T.serif,fontStyle:"italic",fontSize:13,color:"#fff"}}>v</span></div>
                  <span style={{fontFamily:T.serif,fontSize:16,color:T.text,fontWeight:500}}>Vera</span>
                </div>
                <button onClick={e=>{e.stopPropagation();onClose();}} style={{background:"none",border:"none",color:T.textMuted,cursor:"pointer",fontSize:22,padding:"0 4px",lineHeight:1,fontWeight:300}}>×</button>
              </div>
            </div>
            <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"16px 20px",display:"flex",flexDirection:"column",gap:10}}>
              {msgs.map((m,i,arr)=><div key={i} style={{...bubble(m.role),animation:i===arr.length-1?"fadeUp 0.2s ease":"none"}}>{m.content}</div>)}
              {stream&&<div style={bubble("assistant")}>{stream}<span style={{opacity:0.35,animation:"blink 1s infinite"}}>▋</span></div>}
              {loading&&!stream&&<div style={{fontSize:12,color:T.textMuted,fontFamily:T.sans,fontStyle:"italic",paddingLeft:2}}>Vera is thinking…</div>}
              <div style={{height:4}}/>
            </div>
            <div style={{padding:"12px 16px 20px",borderTop:`1px solid ${T.borderLight}`,flexShrink:0,display:"flex",gap:10,alignItems:"flex-end"}}>
              <textarea ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={onKeyDown} placeholder="Tell Vera what happened…" rows={1} autoFocus
                style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:20,padding:"10px 16px",fontSize:14,color:T.text,fontFamily:T.sans,fontWeight:300,resize:"none",lineHeight:1.5,maxHeight:100,outline:"none"}}
                onFocus={e=>{e.target.style.borderColor=T.accent;}} onBlur={e=>{e.target.style.borderColor=T.border;}}/>
              <button onClick={e=>{e.stopPropagation();onSend();}} disabled={loading||!input.trim()}
                style={{width:40,height:40,borderRadius:"50%",border:"none",background:(!input.trim()||loading)?T.accentBg:T.accent,color:(!input.trim()||loading)?T.accent:"#fff",cursor:(!input.trim()||loading)?"default":"pointer",fontSize:16,flexShrink:0,transition:"all 0.18s",display:"flex",alignItems:"center",justifyContent:"center"}}>→</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN APP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function App() {
  const [state, setState] = useState(INITIAL_STATE);
  const [view, setView] = useState("today");
  const [msgs, setMsgs] = useState([{role:"assistant",content:"Hey, I'm Vera.\n\nTell me your situation — balance, when you get paid, what's coming out. I'll set everything up."}]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [stream, setStream] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [lastReply, setLastReply] = useState(null);
  const [headsUp, setHeadsUp] = useState(null);
  const chatRef = useRef(null);
  const inputRef = useRef(null);

  const pic = computePicture(state);

  useEffect(()=>{ if(chatRef.current) chatRef.current.scrollTop=chatRef.current.scrollHeight; },[msgs,stream,loading]);

  useEffect(()=>{
    if (!state.setup) return;
    const lowEnv = pic.computedEnvelopes?.find(e => e.allocatedUSD>0 && e.spentUSD/e.allocatedUSD>0.9);
    if (pic.trulyFree < 0) setHeadsUp("Free pool is negative — check Picture");
    else if (lowEnv) setHeadsUp(`${lowEnv.name} almost at limit`);
    else setHeadsUp(null);
  },[state]);

  const send = useCallback(async()=>{
    if (!input.trim()||loading) return;
    const um = {role:"user",content:input.trim()};
    const next = [...msgs,um];
    setMsgs(next); setInput(""); setLoading(true); setStream("");
    try {
      const r = await askVera(next, state, setStream);
      setStream("");
      const reply = r.message||"Got it.";
      setMsgs(p=>[...p,{role:"assistant",content:reply}]);
      setLastReply(reply);
      const allActions=[];
      if (r.actions&&Array.isArray(r.actions)) r.actions.forEach(a=>{ if(a?.type&&a.type!=="none") allActions.push(a); });
      else { if(r.action?.type&&r.action.type!=="none") allActions.push(r.action); if(r.action2?.type&&r.action2.type!=="none") allActions.push(r.action2); }
      if (allActions.length>0) {
        setState(p=>allActions.reduce((s,a)=>applyAction(s,a),p));
        if (allActions.some(a=>a.type==="propose_setup")) setTimeout(()=>setDrawerOpen(false),300);
      }
      if (r.followup) setTimeout(()=>{ setMsgs(p=>[...p,{role:"assistant",content:r.followup}]); setLastReply(r.followup); },420);
    } catch(err) {
      console.error("Vera error:",err);
      const msg=`Error: ${err.message}`;
      setMsgs(p=>[...p,{role:"assistant",content:msg}]); setLastReply(msg);
    }
    setLoading(false);
  },[input,loading,msgs,state]);

  const handleKey = e=>{ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();} };

  const confirmSetup=()=>{
    setState(p=>applyAction(p,{type:"confirm_setup",data:{}}));
    setMsgs(p=>[...p,{role:"assistant",content:"You're set. Welcome to Vera."}]);
    setLastReply("You're set. Welcome to Vera.");
  };
  const cancelSetup=()=>{
    setState(p=>applyAction(p,{type:"cancel_setup",data:{}}));
    setDrawerOpen(true);
    setMsgs(p=>[...p,{role:"assistant",content:"What would you like to change?"}]);
  };

  // ── FORMAT DATE ───────────────────────────────────────────────────────────
  const fmtDate = (ds) => { if(!ds)return""; return new Date(ds+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"}); };

  // ── TODAY VIEW ────────────────────────────────────────────────────────────
  const Today = () => (
    <div style={{overflowY:"auto",flex:1,padding:"24px 20px 100px"}}>
      {!state.setup ? (
        <div style={{padding:"24px 0 0"}}>
          {state.pendingSetup ? (
            <SetupConfirmCard data={state.pendingSetup} location={state.location} onConfirm={confirmSetup} onEdit={cancelSetup}/>
          ) : (
            <div style={{textAlign:"center",padding:"56px 0 0"}}>
              <div style={{fontFamily:T.serif,fontSize:56,fontStyle:"italic",fontWeight:400,color:T.text,lineHeight:1,marginBottom:16}}>vera</div>
              <div style={{fontSize:15,color:T.textSub,lineHeight:1.9,fontFamily:T.sans,fontWeight:300}}>Financial clarity,<br/>every single day.</div>
              <div style={{marginTop:48,display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:T.accent,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontFamily:T.serif,fontStyle:"italic",fontSize:14,color:"#fff"}}>v</span></div>
                <div style={{fontSize:13,color:T.textMuted,fontFamily:T.sans}}>Tap the button to get started</div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Hero */}
          <div style={{marginBottom:20}}>
            <div style={{fontSize:11,fontFamily:T.sans,fontWeight:500,letterSpacing:"0.1em",textTransform:"uppercase",color:T.textMuted,marginBottom:8}}>Free today</div>
            <Amt usd={pic.freeToday} rate={pic.rate} symbol={pic.symbol} size="hero"/>
            <div style={{fontSize:13,color:T.textSub,fontFamily:T.sans,fontWeight:300,marginTop:8}}>
              {pic.daysLeft} day{pic.daysLeft!==1?"s":""} to payday · {fmtUSD(pic.trulyFree)} truly free
            </div>
            {pic.freeSpentToday>0&&(
              <div style={{fontSize:12,color:T.textMuted,fontFamily:T.sans,marginTop:4}}>
                {fmtUSD(pic.freeSpentToday)} spent from free pool today · {fmtUSD(pic.freeTodayTarget)}/day target
              </div>
            )}
            {pic.envelopeRows.filter(e=>e.type==="daily").map(env=>{
              if(env.dailyLeft===null)return null;
              const isLow=env.dailyLeft<(env.allocated/(pic.daysLeft||1))*0.5;
              return (
                <div key={env.name} style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${T.borderLight}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:11,fontFamily:T.sans,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted}}>{env.icon} {env.name} today</div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:T.serif,fontSize:28,color:isLow?T.accent:T.green,lineHeight:1}}>{fmtUSD(env.dailyLeft)}</div>
                    <div style={{fontSize:11,color:T.textMuted,fontFamily:T.sans,marginTop:2}}>{fmtLocal(env.dailyLeft,pic.rate,pic.symbol)} left</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 3 numbers */}
          <div style={{display:"flex",gap:10,marginBottom:12}}>
            {[["Balance",pic.confirmedBalance],["Reserved",pic.totalReserved],["Free",pic.trulyFree]].map(([l,v])=>(
              <Card key={l} style={{flex:1,padding:"14px"}}>
                <div style={{fontSize:10,fontFamily:T.sans,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase",color:T.textMuted,marginBottom:6}}>{l}</div>
                <Amt usd={v} rate={pic.rate} symbol={pic.symbol} size="mid"/>
              </Card>
            ))}
          </div>

          {headsUp&&<div style={{marginBottom:12,padding:"11px 15px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:12,fontSize:13,color:T.accent,fontFamily:T.sans,display:"flex",gap:8}}><span>↑</span><span>{headsUp}</span></div>}

          {/* Stale bills */}
          {pic.staleCommitted.length>0&&(
            <div onClick={()=>setDrawerOpen(true)} style={{marginBottom:12,padding:"11px 15px",background:T.accentBg,border:`1px solid ${T.accentBorder}`,borderRadius:12,fontSize:13,color:T.accent,fontFamily:T.sans,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>⚠ {pic.staleCommitted.map(c=>c.name).join(", ")} — did you pay {pic.staleCommitted.length===1?"this":"these"}?</span>
              <span style={{fontSize:11,opacity:0.7}}>tap to tell Vera</span>
            </div>
          )}

          {/* Due soon */}
          {pic.imminentBills.length>0&&(
            <Card style={{padding:"14px 20px",marginBottom:12,background:"#fffbf9",border:`1px solid ${T.accentBorder}`}}>
              <Label>Due soon</Label>
              {pic.imminentBills.map(c=>(
                <div key={c.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${T.borderLight}`}}>
                  <div>
                    <span style={{fontSize:13,color:T.text,fontFamily:T.sans}}>{c.name}</span>
                    <span style={{fontSize:10,marginLeft:8,fontFamily:T.sans,padding:"2px 6px",borderRadius:4,color:c.autoPay?T.green:T.accent,background:c.autoPay?T.greenBg:T.accentBg}}>
                      {c.autoPay?"auto-pay":c.nextDate===pic.today?"due today":`${daysUntil(c.nextDate)}d`}
                    </span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:13,fontFamily:T.serif,color:T.accent}}>{fmtUSD(c.amount)}</div>
                    <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(c.amount,pic.rate,pic.symbol)}</div>
                  </div>
                </div>
              ))}
              <div style={{paddingTop:8,fontSize:11,color:T.textMuted,fontFamily:T.sans}}>Tell Vera when you've paid · see all on Picture</div>
            </Card>
          )}

          {/* Allowances */}
          {pic.envelopeRows.length>0&&(
            <Card style={{padding:"18px 20px",marginBottom:12}}>
              <Label>Allowances</Label>
              {pic.envelopeRows.map(env=>(
                <div key={env.name} style={{padding:"11px 0",borderBottom:`1px solid ${T.borderLight}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:7}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:12}}>{env.icon}</span>
                        <span style={{fontSize:13,color:T.text,fontFamily:T.sans,fontWeight:500}}>{env.name}</span>
                        {env.type==="daily"&&env.dailyLeft!==null&&(
                          <span style={{fontSize:10,fontFamily:T.sans,fontWeight:600,color:env.dailyLeft<5?T.accent:T.green,background:env.dailyLeft<5?T.accentBg:T.greenBg,padding:"2px 7px",borderRadius:10}}>
                            {fmtUSD(env.dailyLeft)} left today
                          </span>
                        )}
                      </div>
                      {env.type==="daily"&&env.dailyLeft!==null&&(
                        <div style={{fontSize:11,color:T.textMuted,fontFamily:T.sans,marginTop:2,paddingLeft:20}}>
                          {fmtLocal(env.dailyLeft,pic.rate,pic.symbol)} in {pic.spendCurrency}
                        </div>
                      )}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:12,fontFamily:T.serif,color:env.isOver?T.accent:T.textSub}}>
                        {fmtUSD(env.cycleSpend)} <span style={{color:T.textMuted,fontSize:10}}>/ {fmtUSD(env.allocated)}</span>
                      </div>
                      <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>this cycle</div>
                    </div>
                  </div>
                  <div style={{height:3,background:T.borderLight,borderRadius:2}}>
                    <div style={{height:3,width:`${env.pct}%`,background:env.pct>85?T.accent:env.pct>60?"#e8a84a":T.green,borderRadius:2,transition:"width 0.4s ease"}}/>
                  </div>
                </div>
              ))}
            </Card>
          )}

          {/* Category spend — unbudgeted */}
          {pic.categoryRows.filter(r=>!r.env).length>0&&(
            <Card style={{padding:"18px 20px",marginBottom:12}}>
              <Label>Spending this cycle</Label>
              {pic.categoryRows.filter(r=>!r.env).map(row=>(
                <div key={row.parentId} style={{padding:"9px 0",borderBottom:`1px solid ${T.borderLight}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",gap:7,alignItems:"center"}}>
                      <span style={{fontSize:12}}>{row.icon}</span>
                      <span style={{fontSize:13,color:T.text,fontFamily:T.sans}}>{row.label}</span>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:13,fontFamily:T.serif,color:T.textSub}}>{fmtUSD(row.spent)}</div>
                      <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(row.spent,pic.rate,pic.symbol)}</div>
                    </div>
                  </div>
                  {row.subs.length>1&&(
                    <div style={{paddingLeft:20,marginTop:4}}>
                      {row.subs.map(sub=>(
                        <div key={sub.subId} style={{display:"flex",justifyContent:"space-between",padding:"2px 0"}}>
                          <span style={{fontSize:11,color:T.textMuted,fontFamily:T.sans}}>{sub.label}</span>
                          <span style={{fontSize:11,fontFamily:T.serif,color:T.textMuted}}>{fmtUSD(sub.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <div style={{paddingTop:8,fontSize:11,color:T.textMuted,fontFamily:T.sans}}>Tell Vera to set an allowance for any of these</div>
            </Card>
          )}

          {/* Savings */}
          {(state.savings||0)>0&&(
            <Card style={{padding:"14px 20px",marginBottom:12,background:T.greenBg,border:"1px solid #c8e0d0"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:T.green,fontFamily:T.sans,fontWeight:500}}>Savings</span>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:16,color:T.green,fontFamily:T.serif}}>{fmtUSD(state.savings)}</div>
                  <div style={{fontSize:10,color:T.green,fontFamily:T.sans,opacity:0.7}}>{fmtLocal(state.savings,pic.rate,pic.symbol)}</div>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );

  // ── PICTURE VIEW ──────────────────────────────────────────────────────────
  const Picture = () => {
    if (!state.setup) return <div style={{overflowY:"auto",flex:1,padding:"20px 20px 100px"}}><div style={{textAlign:"center",padding:"80px 0 0",fontSize:13,color:T.textMuted,fontFamily:T.sans}}>Set up first.</div></div>;

    const BucketRow = ({label,sub,amount,color,last=false}) => (
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:last?0:9,marginBottom:last?0:9,borderBottom:last?"none":`1px solid ${T.borderLight}`}}>
        <div>
          <div style={{fontSize:12,color:T.textMuted,fontFamily:T.sans}}>{label}</div>
          {sub&&<div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,marginTop:1}}>{sub}</div>}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:13,fontFamily:T.serif,color:amount>0?color:T.textMuted}}>{amount>0?`− ${fmtUSD(amount)}`:"—"}</div>
          {amount>0&&<div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(amount,pic.rate,pic.symbol)}</div>}
        </div>
      </div>
    );

    const activeEnvList = Object.values(state.envelopes||{}).filter(e=>e.active);

    return (
      <div style={{overflowY:"auto",flex:1,padding:"20px 20px 100px"}}>

        {/* Four buckets */}
        <Label>Now</Label>
        <Card style={{padding:"20px",marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:12,marginBottom:12,borderBottom:`1px solid ${T.borderLight}`}}>
            <span style={{fontSize:13,color:T.textMuted,fontFamily:T.sans}}>Balance</span>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:16,fontFamily:T.serif,color:T.text}}>{fmtUSD(pic.confirmedBalance)}</div>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(pic.confirmedBalance,pic.rate,pic.symbol)}</div>
            </div>
          </div>
          <BucketRow label="Bills due" sub={pic.upcomingCommitted.map(c=>c.name).join(", ")||null} amount={pic.bucket1} color={T.accent}/>
          <BucketRow label="Planned spending" sub={activeEnvList.filter(e=>e.reserveFromPool&&e.type!=="daily").map(e=>e.name).join(", ")||null} amount={pic.bucket2} color="#8b6914"/>
          <BucketRow label="Daily allowances" sub={activeEnvList.filter(e=>e.type==="daily").map(e=>e.name).join(", ")||null} amount={pic.bucket3} color="#5b7fa6"/>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:9,marginTop:9,borderTop:`1px solid ${T.borderLight}`}}>
            <div>
              <span style={{fontSize:13,fontFamily:T.sans,fontWeight:600,color:T.text}}>Truly free</span>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,marginTop:1}}>{fmtUSD(pic.freeToday)}/day · {pic.daysLeft}d left</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:18,fontFamily:T.serif,color:pic.trulyFree<0?T.accent:T.green}}>{fmtUSD(pic.trulyFree)}</div>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(pic.trulyFree,pic.rate,pic.symbol)}</div>
            </div>
          </div>
          {(state.savings||0)>0&&(
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:10,paddingTop:10,borderTop:`1px solid ${T.borderLight}`}}>
              <span style={{fontSize:12,color:T.green,fontFamily:T.sans}}>Savings</span>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:13,fontFamily:T.serif,color:T.green}}>{fmtUSD(state.savings)}</div>
                <div style={{fontSize:10,color:T.green,fontFamily:T.sans,opacity:0.7}}>{fmtLocal(state.savings,pic.rate,pic.symbol)}</div>
              </div>
            </div>
          )}
        </Card>

        {/* Coming up timeline */}
        <Label>Coming up · {pic.daysLeft}d to payday</Label>
        <Card style={{padding:"0 20px",marginBottom:16}}>
          {pic.timeline.length===0
            ?<div style={{padding:"16px 0",fontSize:13,color:T.textMuted,fontFamily:T.sans}}>Nothing due before payday.</div>
            :pic.timeline.map((item,i)=>(
              <div key={i} style={{display:"flex",alignItems:"stretch",padding:"14px 0",borderBottom:i<pic.timeline.length-1?`1px solid ${T.borderLight}`:"none"}}>
                <div style={{width:44,flexShrink:0,paddingTop:2}}>
                  <div style={{fontSize:11,fontFamily:T.sans,fontWeight:600,color:item.type==="payday"?T.green:T.accent}}>{fmtDate(item.date)}</div>
                </div>
                <div style={{width:1,background:item.type==="payday"?T.green:T.accentBorder,margin:"0 14px",flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                    <div>
                      <div style={{fontSize:13,fontFamily:T.sans,fontWeight:500,color:item.type==="payday"?T.green:T.text}}>{item.name}</div>
                      {item.type==="payday"&&item.saving>0&&<div style={{fontSize:11,color:T.textMuted,fontFamily:T.sans,marginTop:2}}>{fmtUSD(item.saving)} to savings</div>}
                      {item.type==="bill"&&<div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,marginTop:2,textTransform:"uppercase",letterSpacing:"0.06em"}}>{item.frequency}</div>}
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:13,fontFamily:T.serif,color:item.type==="payday"?T.green:T.accent}}>
                        {item.type==="payday"?`+ ${fmtUSD(item.net)}`:`− ${fmtUSD(item.amount)}`}
                      </div>
                      <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>
                        {fmtLocal(item.type==="payday"?item.net:item.amount,pic.rate,pic.symbol)}
                      </div>
                    </div>
                  </div>
                  <div style={{marginTop:6,fontSize:11,color:T.textMuted,fontFamily:T.sans}}>
                    balance after: <span style={{color:item.balanceAfter<0?T.accent:T.textSub,fontFamily:T.serif}}>{fmtUSD(item.balanceAfter)}</span>
                    <span> · {fmtLocal(item.balanceAfter,pic.rate,pic.symbol)}</span>
                  </div>
                </div>
              </div>
            ))
          }
        </Card>

        {/* Allowances in Picture */}
        {pic.envelopeRows.length>0&&(
          <>
            <Label>Allowances</Label>
            <Card style={{padding:"0 20px",marginBottom:16}}>
              {pic.envelopeRows.map((env,i,arr)=>(
                <div key={env.name} style={{padding:"12px 0",borderBottom:i<arr.length-1?`1px solid ${T.borderLight}`:"none"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <div>
                      <span style={{fontSize:13,fontFamily:T.sans}}>{env.icon} {env.name}</span>
                      {env.type==="daily"&&<span style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,marginLeft:6}}>$${env.allocated>0?(env.allocated/(pic.daysLeft||1)).toFixed(0):0}/day target</span>}
                    </div>
                    <span style={{fontSize:12,fontFamily:T.serif,color:env.pct>80?T.accent:T.textSub}}>
                      {fmtUSD(env.cycleSpend)} / {fmtUSD(env.allocated)}
                    </span>
                  </div>
                  <div style={{height:3,background:T.borderLight,borderRadius:2}}>
                    <div style={{height:3,width:`${env.pct}%`,background:env.pct>85?T.accent:env.pct>60?"#e8a84a":T.green,borderRadius:2}}/>
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}

        {/* All commitments */}
        {(() => {
          const all = Object.values(state.committed||{}).filter(c=>c.active&&!c.parkedForNextCycle);
          if (!all.length) return null;
          const recurring = all.filter(c=>c.frequency!=="once");
          const oneTime = all.filter(c=>c.frequency==="once");
          const monthlyTotal = recurring.reduce((s,c)=>{
            if(c.frequency==="monthly")return s+(c.amountUSD||0);
            if(c.frequency==="weekly")return s+(c.amountUSD||0)*4.33;
            if(c.frequency==="annual")return s+(c.amountUSD||0)/12;
            return s;
          },0);
          const FreqBadge=({f})=><span style={{fontSize:9,fontFamily:T.sans,fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase",color:f==="once"?"#8b6914":T.green,background:f==="once"?"#fdf6e3":T.greenBg,padding:"2px 6px",borderRadius:4}}>{f==="monthly"?"mo":f==="weekly"?"wk":f==="annual"?"yr":"once"}</span>;
          return (
            <>
              <Label>All commitments</Label>
              <Card style={{padding:"0 20px",marginBottom:16}}>
                {[...recurring,...oneTime].map((c,i,arr)=>(
                  <div key={c.name} style={{padding:"13px 0",borderBottom:i<arr.length-1?`1px solid ${T.borderLight}`:"none"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                          <span style={{fontSize:13,color:T.text,fontFamily:T.sans,fontWeight:500}}>{c.name}</span>
                          <FreqBadge f={c.frequency}/>
                          {c.autoPay&&<span style={{fontSize:9,fontFamily:T.sans,color:T.green,background:T.greenBg,padding:"2px 6px",borderRadius:4}}>auto</span>}
                          {c.paidThisCycle&&<span style={{fontSize:9,fontFamily:T.sans,color:T.green}}>✓ paid</span>}
                        </div>
                        <div style={{fontSize:11,color:T.textMuted,fontFamily:T.sans}}>
                          next {c.nextDate}
                          {c.nextDate>pic.payday?<span style={{color:T.textMuted}}> · next cycle</span>:<span style={{color:T.accent}}> · this cycle</span>}
                        </div>
                      </div>
                      <div style={{textAlign:"right",marginLeft:12}}>
                        <div style={{fontSize:14,fontFamily:T.serif,color:T.textSub}}>{fmtUSD(c.amountUSD||0)}</div>
                        <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(c.amountUSD||0,pic.rate,pic.symbol)}</div>
                      </div>
                    </div>
                  </div>
                ))}
                {recurring.length>0&&(
                  <div style={{paddingTop:12,marginTop:2,borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                    <span style={{fontSize:11,color:T.textMuted,fontFamily:T.sans}}>Monthly total</span>
                    <div style={{textAlign:"right"}}>
                      <span style={{fontSize:15,fontFamily:T.serif,color:T.text}}>{fmtUSD(monthlyTotal)}</span>
                      <span style={{fontSize:10,color:T.textMuted,fontFamily:T.sans,marginLeft:6}}>{fmtLocal(monthlyTotal,pic.rate,pic.symbol)}/mo</span>
                    </div>
                  </div>
                )}
              </Card>
            </>
          );
        })()}

        {/* Parked */}
        {Object.values(state.committed||{}).filter(c=>c.parkedForNextCycle).length>0&&(
          <>
            <Label>Planned next cycle</Label>
            <Card style={{padding:"0 20px",marginBottom:16,opacity:0.7}}>
              {Object.values(state.committed||{}).filter(c=>c.parkedForNextCycle).map((c,i,arr)=>(
                <div key={c.name} style={{padding:"11px 0",borderBottom:i<arr.length-1?`1px solid ${T.borderLight}`:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:13,color:T.text,fontFamily:T.sans}}>{c.name}</div>
                    <div style={{fontSize:11,color:T.textMuted,fontFamily:T.sans,marginTop:2}}>activates when income lands</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:13,fontFamily:T.serif,color:T.textMuted}}>{fmtUSD(c.amountUSD||0)}</div>
                    <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(c.amountUSD||0,pic.rate,pic.symbol)}</div>
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}
      </div>
    );
  };

  // ── LEDGER VIEW ───────────────────────────────────────────────────────────
  const Ledger = () => {
    const getCatLabel=(e)=>{
      if(!e.parentId||e.parentId==="other")return null;
      const parent=TAXONOMY[e.parentId]; if(!parent)return null;
      const sub=parent.subs[e.subId];
      return sub?`${parent.icon} ${parent.label} › ${sub.label}`:`${parent.icon} ${parent.label}`;
    };
    const amt=(e)=>e.amountUSD!=null?e.amountUSD:0;
    const col=(e)=>e.type==="income"||e.type==="setup"?T.green:e.type==="correction"?T.textSub:T.accent;
    return (
      <div style={{overflowY:"auto",flex:1,padding:"20px 20px 100px"}}>
        <Card style={{padding:"20px"}}>
          <Label>Transaction history</Label>
          {state.ledger.length===0
            ?<div style={{fontSize:13,color:T.textMuted,fontFamily:T.sans}}>No entries yet</div>
            :[...state.ledger].reverse().map(e=>(
              <div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"11px 0",borderBottom:`1px solid ${T.borderLight}`}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,color:T.text,fontFamily:T.sans}}>{e.description||e.note||e.type}</div>
                  <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>
                    {e.date} · {e.type}
                    {getCatLabel(e)&&<span style={{marginLeft:6}}>{getCatLabel(e)}</span>}
                    {e.localAmount&&<span style={{marginLeft:6,color:T.textMuted}}>{e.localCurrency||""}{e.localAmount}</span>}
                  </div>
                </div>
                <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
                  <div style={{fontSize:13,fontFamily:T.serif,color:col(e)}}>{e.type==="transaction"?"-":"+"}{fmtUSD(amt(e))}</div>
                  <div style={{fontSize:10,color:T.textMuted,fontFamily:T.sans}}>{fmtLocal(amt(e),pic.rate,pic.symbol)}</div>
                </div>
              </div>
            ))
          }
        </Card>
      </div>
    );
  };

  return (
    <>
      <style>{`* { box-sizing:border-box; margin:0; padding:0; } html,body { height:100%; background:${T.bg}; } textarea { scrollbar-width:none; } textarea::-webkit-scrollbar { display:none; } ::-webkit-scrollbar { width:0; } @keyframes fadeIn { from{opacity:0}to{opacity:1} } @keyframes fadeUp { from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)} } @keyframes blink { 0%,100%{opacity:1}50%{opacity:0.2} }`}</style>
      <div data-vera-root style={{height:"100vh",background:T.bg,fontFamily:T.sans,color:T.text,display:"flex",flexDirection:"column",maxWidth:480,margin:"0 auto",position:"relative",overflow:"hidden"}}>
        <div style={{padding:"18px 24px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:`1px solid ${T.border}`,flexShrink:0,background:T.surface}}>
          <div style={{fontFamily:T.serif,fontSize:22,fontStyle:"italic",fontWeight:400,color:T.text}}>vera</div>
          {state.setup&&(
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontSize:11,color:T.textMuted,letterSpacing:"0.04em",fontFamily:T.sans}}>{pic.daysLeft}d</div>
              <LocationPill location={state.location} onTap={()=>setDrawerOpen(true)}/>
            </div>
          )}
        </div>
        <div style={{display:"flex",borderBottom:`1px solid ${T.border}`,flexShrink:0,background:T.surface}}>
          {[["today","Today"],["picture","Picture"],["ledger","Ledger"]].map(([v,l])=>(
            <button key={v} onClick={()=>setView(v)} style={{flex:1,padding:"11px 0",border:"none",background:"none",cursor:"pointer",fontSize:12,fontFamily:T.sans,fontWeight:view===v?500:300,color:view===v?T.accent:T.textMuted,letterSpacing:"0.06em",borderBottom:view===v?`2px solid ${T.accent}`:"2px solid transparent",marginBottom:-1,transition:"all 0.15s"}}>{l}</button>
          ))}
        </div>
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0}}>
          {view==="today"&&<Today/>}
          {view==="picture"&&<Picture/>}
          {view==="ledger"&&<Ledger/>}
        </div>
        <VeraPortal open={drawerOpen} onOpen={()=>setDrawerOpen(true)} onClose={()=>setDrawerOpen(false)} hasAlert={!!headsUp} lastReply={lastReply} msgs={msgs} stream={stream} loading={loading} input={input} setInput={setInput} onSend={send} onKeyDown={handleKey} inputRef={inputRef} chatRef={chatRef}/>
      </div>
    </>
  );
}
