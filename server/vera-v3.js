"use strict";
const crypto = require("crypto");
function toCents(v) { if (v == null) return 0; const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : v; return (isNaN(n) || !isFinite(n)) ? 0 : Math.round(n * 100); }
function toMoney(cents, sym) { if (cents == null) return (sym||"$")+"0.00"; const neg = cents<0, abs = Math.abs(cents); return (neg?"-":"")+(sym||"$")+Math.floor(abs/100).toLocaleString()+"."+String(abs%100).padStart(2,"0"); }
function toShort(c,s) { const v = toMoney(c,s); return v.endsWith(".00") ? v.slice(0,-3) : v; }
function today(tz) { if(!tz||tz==="UTC") return new Date().toISOString().slice(0,10); try { return new Date().toLocaleDateString("en-CA",{timeZone:tz}); } catch { return new Date().toISOString().slice(0,10); } }
function daysUntil(ds, tz) { if (!ds) return 30; return Math.max(1, Math.ceil((new Date(ds+"T00:00:00")-new Date(today(tz)+"T00:00:00"))/86400000)); }
function daysBetween(a,b) { return Math.max(1, Math.ceil((new Date(b+"T00:00:00")-new Date(a+"T00:00:00"))/86400000)); }
function uid() { return crypto.randomBytes(12).toString("hex"); }
function ekey(name) { return (name??"").toLowerCase().trim().replace(/\s+/g,"_"); }
function monthKey(d) { return d && d.length>=7 ? d.slice(0,7) : null; }
function normalizeDate(d) { if (!d) return null; if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return isNaN(new Date(d+"T00:00:00").getTime())?null:d; const dt = new Date(d); return isNaN(dt.getTime())?null:dt.toISOString().slice(0,10); }
function createFreshState() { return { setup:false, balanceCents:0, currency:"USD", currencySymbol:"$", language:"en", timezone:"UTC", payday:null, cycleStart:null, envelopes:{}, transactions:[], conversationHistory:[], monthlySummaries:{}, cycleHistory:[], undoSnapshot:null }; }
function updateMonthly(s,date,ek,amt,type) { const mk=monthKey(date); if(!mk) return; if(!s.monthlySummaries[mk]) s.monthlySummaries[mk]={}; const m=s.monthlySummaries[mk],nk=ek||"_free"; if(!m[nk]) m[nk]={spent:0,earned:0,count:0}; if(type==="income") m[nk].earned+=amt; else { m[nk].spent+=amt; m[nk].count+=(amt>=0?1:-1); } if(!m._total) m._total={spent:0,earned:0,count:0}; if(type==="income") m._total.earned+=amt; else { m._total.spent+=amt; m._total.count+=(amt>=0?1:-1); } }
function archiveCycle(s) { if(!s.cycleStart||!s.setup) return; let tot=0,txC=0; const es={}; for(const [k,e] of Object.entries(s.envelopes)){if(e.active&&e.spentCents>0){es[k]=e.spentCents;tot+=e.spentCents;}} for(const tx of s.transactions){if(tx.date<s.cycleStart)continue;if(tx.type==="spend"||tx.type==="refund"){txC++;if(!tx.envelope||tx.envelope==="free")tot+=tx.amountCents;}} const ce=today(s.timezone||"UTC"),days=daysBetween(s.cycleStart,ce); s.cycleHistory.push({cycleStart:s.cycleStart,cycleEnd:ce,totalSpentCents:tot,envSpend:es,txCount:txC,daysInCycle:days,avgDailySpend:days>0?Math.round(tot/days):0}); if(s.cycleHistory.length>12)s.cycleHistory=s.cycleHistory.slice(-12); }
function matchEnvelope(s,desc) { if(!desc) return null; const lower=desc.toLowerCase(); let best=null,bestLen=0; for(const[key,e] of Object.entries(s.envelopes)){if(!e.active)continue;for(const kw of(e.keywords||[])){if(lower.includes(kw.toLowerCase())&&kw.length>bestLen){best=key;bestLen=kw.length;}}if(lower.includes(key)&&key.length>bestLen){best=key;bestLen=key.length;}} return best; }
function countOccurrences(nd,iv,end) { if(!nd||!end) return 1; let c=0,d=new Date(nd+"T00:00:00"); const e=new Date(end+"T00:00:00"); iv=iv||30; while(d<=e&&c<100){c++;d.setDate(d.getDate()+iv);} return Math.max(c,0); }
function envelopeReserve(env,daysLeft,payday) { if(!env.active) return 0; switch(env.rhythm){ case "daily":return Math.max(0,(env.amountCents*daysLeft)-env.spentCents); case "weekly":return Math.max(0,(env.amountCents*Math.ceil(daysLeft/7))-env.spentCents); case "monthly":case "on_income":return Math.max(0,env.amountCents-env.spentCents); case "once":return Math.max(0,env.amountCents-(env.spentCents||0)); case "ongoing":return Math.max(0,(env.fundedCents||0)-(env.spentCents||0)); default:if(env.nextDate) return env.amountCents*countOccurrences(env.nextDate,env.intervalDays,payday); return env.amountCents; } }
function todaySpendOn(s,ek) { const t=today(s.timezone); let c=0; for(const tx of s.transactions){if(tx.date===t&&tx.envelope===ek&&tx.type==="spend")c+=tx.amountCents;} return c; }
function todayUnmatched(s) { const t=today(s.timezone); let c=0; for(const tx of s.transactions){if(tx.date===t&&(tx.type==="spend"||tx.type==="refund")&&(!tx.envelope||tx.envelope==="free"))c+=tx.amountCents;} return c; }
function todayTotal(s) { const t=today(s.timezone); let c=0; for(const tx of s.transactions){if(tx.date===t&&(tx.type==="spend"||tx.type==="refund"))c+=tx.amountCents;} return c; }
function applyAction(state, action) {
  if (!action||!action.type) return state;
  const s = JSON.parse(JSON.stringify(state)), d = action.data||{};
  const tz = s.timezone || "UTC";
  switch (action.type) {
    case "setup": { if (d.balanceUSD==null) return s; s.setup=true; s.balanceCents=toCents(d.balanceUSD); let pd=d.payday?normalizeDate(d.payday):null; if(pd){const now=new Date(today(tz)+"T00:00:00");let dt=new Date(pd+"T00:00:00");while(dt<=now)dt.setMonth(dt.getMonth()+1);pd=dt.toISOString().slice(0,10);} s.payday=pd||(()=>{const f=new Date(today(tz)+"T00:00:00");f.setDate(f.getDate()+30);return f.toISOString().slice(0,10);})(); s.cycleStart=d.cycleStart||today(tz); if(d.currency)s.currency=d.currency; if(d.symbol)s.currencySymbol=d.symbol; if(d.timezone)s.timezone=d.timezone; s.transactions.push({id:uid(),type:"setup",amountCents:s.balanceCents,description:"Initial balance",envelope:null,date:today(tz),ts:Date.now()}); return s; }
    case "create_envelope": { const key=ekey(d.name); if(!key) return s; s.envelopes[key]={name:d.name||key,amountCents:toCents(d.amountUSD||0),targetCents:d.targetUSD?toCents(d.targetUSD):null,fundedCents:d.fundedUSD?toCents(d.fundedUSD):0,spentCents:0,fundRate:d.fundRate!=null?Math.min(10000,Math.max(0,Math.round(d.fundRate*10000))):null,fundAmountCents:d.fundAmountUSD?toCents(d.fundAmountUSD):null,intervalDays:d.intervalDays||30,nextDate:d.nextDate?normalizeDate(d.nextDate):null,keywords:d.keywords||[],rhythm:d.rhythm||"monthly",priority:d.priority||"flexible",active:true}; return s; }
    case "update_envelope": { const key=ekey(d.name),env=s.envelopes[key]; if(!env) return s; if(d.amountUSD!==undefined)env.amountCents=toCents(d.amountUSD); if(d.targetUSD!==undefined)env.targetCents=toCents(d.targetUSD); if(d.addFundedUSD!==undefined)env.fundedCents=Math.max(0,env.fundedCents+toCents(d.addFundedUSD)); if(d.fundRate!==undefined)env.fundRate=Math.min(10000,Math.max(0,Math.round(d.fundRate*10000))); if(d.fundAmountUSD!==undefined)env.fundAmountCents=toCents(d.fundAmountUSD); if(d.keywords!==undefined)env.keywords=d.keywords; if(d.rhythm!==undefined)env.rhythm=d.rhythm; if(d.priority!==undefined)env.priority=d.priority; if(d.nextDate!==undefined)env.nextDate=normalizeDate(d.nextDate); if(d.intervalDays!==undefined)env.intervalDays=d.intervalDays; if(d.active!==undefined)env.active=d.active; return s; }
    case "remove_envelope": { const key=ekey(d.name); if(s.envelopes[key])s.envelopes[key].active=false; return s; }
    case "spend": { const amt=toCents(d.amountUSD); if(amt===0) return s; s.balanceCents-=amt; const ek=d.envelope?ekey(d.envelope):matchEnvelope(s,d.description||""); if(ek&&s.envelopes[ek]&&s.envelopes[ek].active)s.envelopes[ek].spentCents+=amt; const txType=amt<0?"refund":"spend",txDate=today(tz); s.transactions.push({id:uid(),type:txType,amountCents:amt,description:d.description||"",envelope:ek||"free",date:txDate,ts:Date.now()}); updateMonthly(s,txDate,ek,amt,txType); return s; }
    case "pay_envelope": { const key=ekey(d.name),env=s.envelopes[key]; if(!env||!env.active) return s; const payAmt=d.amountUSD!==undefined?toCents(d.amountUSD):env.amountCents; s.balanceCents-=payAmt; env.spentCents+=payAmt; const txDate=today(tz); s.transactions.push({id:uid(),type:"envelope_payment",amountCents:payAmt,description:"Paid: "+env.name,envelope:key,date:txDate,ts:Date.now()}); updateMonthly(s,txDate,key,payAmt,"envelope_payment"); if(env.nextDate){const dt=new Date(env.nextDate+"T00:00:00");dt.setDate(dt.getDate()+(env.intervalDays||30));env.nextDate=dt.toISOString().slice(0,10);} return s; }
    case "skip_envelope": { const key=ekey(d.name),env=s.envelopes[key]; if(!env||!env.active||!env.nextDate) return s; const dt=new Date(env.nextDate+"T00:00:00");dt.setDate(dt.getDate()+(env.intervalDays||30));env.nextDate=dt.toISOString().slice(0,10); return s; }
    case "income": { const amt=Math.max(0,toCents(d.amountUSD)); if(amt===0) return s; archiveCycle(s); s.balanceCents+=amt; const pctE=[],fixE=[]; for(const[k,e] of Object.entries(s.envelopes)){if(!e.active)continue;if(e.fundRate>0)pctE.push([k,e]);else if(e.fundAmountCents>0)fixE.push([k,e]);} const sp=(a,b)=>(a[1].priority==="essential"?0:1)-(b[1].priority==="essential"?0:1); pctE.sort(sp);fixE.sort(sp); let funded=0; const fundLog=[]; for(const[k,e] of pctE){const c=Math.min(Math.round(amt*e.fundRate/10000),Math.max(0,amt-funded));e.fundedCents+=c;funded+=c;fundLog.push({name:e.name,amount:c});} for(const[k,e] of fixE){const want=e.fundAmountCents,avail=amt-funded,c=Math.min(want,Math.max(0,avail));if(c>0){e.fundedCents+=c;funded+=c;fundLog.push({name:e.name,amount:c});}} for(const[k,e] of Object.entries(s.envelopes)){if(e.active&&["daily","weekly","monthly","on_income"].includes(e.rhythm))e.spentCents=0;} if(d.nextPayday){const np=normalizeDate(d.nextPayday);if(np)s.payday=np;} s.cycleStart=today(tz); s.transactions.push({id:uid(),type:"income",amountCents:amt,description:d.description||"Income",envelope:null,date:today(tz),ts:Date.now()}); updateMonthly(s,today(tz),null,amt,"income"); s._lastFundLog=fundLog;s._lastIncome=amt; return s; }
    case "fund_envelope": { const key=ekey(d.name),env=s.envelopes[key]; if(!env||!env.active) return s; const amt=toCents(d.amountUSD); if(amt<=0) return s; env.fundedCents+=amt; s.transactions.push({id:uid(),type:"fund_envelope",amountCents:amt,description:"Fund: "+env.name,envelope:key,date:today(tz),ts:Date.now()}); return s; }
    case "correction": { if(d.balanceUSD==null) return s; const prev=s.balanceCents; s.balanceCents=toCents(d.balanceUSD); s.transactions.push({id:uid(),type:"correction",amountCents:s.balanceCents-prev,description:d.description||"Balance correction",envelope:null,date:today(tz),ts:Date.now()}); return s; }
    case "edit_spend": {
      const tx = s.transactions.find(t => t.id === d.txId);
      if (!tx) return s;
      const oldAmt = tx.amountCents;
      const newAmt = d.newAmountUSD !== undefined ? toCents(d.newAmountUSD) : oldAmt;
      // Reverse old balance effect, apply new
      s.balanceCents += oldAmt;
      s.balanceCents -= newAmt;
      // Adjust envelope if applicable
      const ek = tx.envelope && tx.envelope !== "free" ? tx.envelope : null;
      if (ek && s.envelopes[ek]) {
        s.envelopes[ek].spentCents = Math.max(0, s.envelopes[ek].spentCents - oldAmt + newAmt);
      }
      // Update monthly: reverse old, apply new
      updateMonthly(s, tx.date, ek, -oldAmt, tx.type);
      updateMonthly(s, tx.date, ek, newAmt, tx.type);
      // Update the transaction
      tx.amountCents = newAmt;
      if (d.newDescription !== undefined) tx.description = d.newDescription;
      return s;
    }
    case "delete_spend": {
      const idx = s.transactions.findIndex(t => t.id === d.txId);
      if (idx === -1) return s;
      const tx = s.transactions[idx];
      // Only allow deleting spend/refund/envelope_payment
      if (!["spend", "refund", "envelope_payment"].includes(tx.type)) return s;
      // Reverse balance effect
      s.balanceCents += tx.amountCents;
      // Reverse envelope effect
      const ek = tx.envelope && tx.envelope !== "free" ? tx.envelope : null;
      if (ek && s.envelopes[ek]) {
        s.envelopes[ek].spentCents = Math.max(0, s.envelopes[ek].spentCents - tx.amountCents);
      }
      // Reverse monthly
      updateMonthly(s, tx.date, ek, -tx.amountCents, tx.type);
      // Remove transaction
      s.transactions.splice(idx, 1);
      return s;
    }
    case "undo": { return s.undoSnapshot?JSON.parse(JSON.stringify(s.undoSnapshot)):s; }
    case "reset": return createFreshState();
    default: return s;
  }
}
module.exports = { toCents,toMoney,toShort,today,daysUntil,daysBetween,monthKey,uid,ekey,createFreshState,applyAction,matchEnvelope,envelopeReserve,countOccurrences,updateMonthly,archiveCycle,todayUnmatched,todayTotal,todaySpendOn,normalizeDate };

// Re-export computePicture and runQuery from the split module.
// This require() is AFTER module.exports is set, so vera-v3-picture.js
// sees all utility functions when it does require("./vera-v3").
const _pic = require("./vera-v3-picture");
module.exports.computePicture = _pic.computePicture;
module.exports.runQuery = _pic.runQuery;
