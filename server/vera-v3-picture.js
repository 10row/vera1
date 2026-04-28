"use strict";
// V3 computePicture — separated to keep vera-v3.js under mount limit
const v3 = require("./vera-v3");

function computePicture(state) {
  const s = JSON.parse(JSON.stringify(state));
  if (!s.setup) return { setup: false };
  const tz = s.timezone || "UTC"; const sym = s.currencySymbol||"$", M = c => v3.toMoney(c,sym), dl = v3.daysUntil(s.payday, tz), t = v3.today(tz);
  const dueEnvelopes = [];
  for (const [k,e] of Object.entries(s.envelopes)) {
    if (e.active && e.nextDate && e.nextDate <= t) { e._isDue=true; dueEnvelopes.push({key:k,name:e.name,amountCents:e.amountCents,amountFormatted:v3.toShort(e.amountCents,sym),nextDate:e.nextDate}); }
  }
  let totalReserved = 0; const envList = [];
  for (const [key,e] of Object.entries(s.envelopes)) {
    if (!e.active) continue;
    const reserved = v3.envelopeReserve(e, dl, s.payday); totalReserved += reserved;
    let todayRem = null;
    if (e.rhythm === "daily") todayRem = Math.max(0, e.amountCents - v3.todaySpendOn(s, key));
    envList.push({key,name:e.name,rhythm:e.rhythm,priority:e.priority,amountCents:e.amountCents,targetCents:e.targetCents,fundedCents:e.fundedCents,spentCents:e.spentCents,reservedCents:reserved,remainingCents:Math.max(0,reserved),todayRemainingCents:todayRem,nextDate:e.nextDate,isDue:e._isDue||false,daysUntilDue:e.nextDate?v3.daysUntil(e.nextDate,tz):null,intervalDays:e.intervalDays,keywords:e.keywords||[],active:true,amountFormatted:v3.toShort(e.amountCents,sym),reservedFormatted:v3.toShort(reserved,sym),spentFormatted:v3.toShort(e.spentCents,sym),fundedFormatted:e.fundedCents>0?v3.toShort(e.fundedCents,sym):null,targetFormatted:e.targetCents?v3.toShort(e.targetCents,sym):null});
  }
  const free = s.balanceCents - totalReserved;
  const checksumOk = (totalReserved + free) === s.balanceCents;
  if (!checksumOk) console.error("EQUATION BROKEN: r="+totalReserved+" f="+free+" b="+s.balanceCents);
  const dailyPace = dl > 0 ? Math.floor(free / dl) : free;
  const freeToday = dailyPace - v3.todayUnmatched(s);
  const wcs = (() => { const d = new Date(t+"T00:00:00"); d.setDate(d.getDate()-7); return d.toISOString().slice(0,10); })();
  let weekSpent = 0;
  for (const tx of s.transactions) { if (tx.date>=wcs && (tx.type==="spend"||tx.type==="refund")) weekSpent+=tx.amountCents; }
  const mk = v3.monthKey(t), mSnap = s.monthlySummaries[mk] || {};
  const monthSpent = mSnap._total ? mSnap._total.spent : 0;
  const cyCut = s.cycleStart || t; let cySpent=0, cyTxC=0;
  for (const tx of s.transactions) { if(tx.date<cyCut) continue; if(tx.type==="spend"||tx.type==="refund"){cySpent+=tx.amountCents;cyTxC++;} if(tx.type==="envelope_payment")cySpent+=tx.amountCents; }
  const cyDays = Math.max(1, v3.daysBetween(cyCut, t));
  let totalSaved = 0; const savingsEnvs = [];
  for (const e of envList) { if ((e.rhythm==="ongoing"||e.targetCents)&&e.fundedCents>0) { totalSaved+=e.fundedCents; savingsEnvs.push(e); } }
  const upcoming = envList.filter(e => e.daysUntilDue!=null && e.daysUntilDue>0 && e.daysUntilDue<=7);
  return {
    setup:true, currency:s.currency||"USD", currencySymbol:sym,
    balanceCents:s.balanceCents, balanceFormatted:M(s.balanceCents),
    freeCents:free, freeFormatted:M(free),
    dailyPaceCents:dailyPace, dailyPaceFormatted:M(dailyPace),
    freeRemainingTodayCents:freeToday, freeRemainingTodayFormatted:M(freeToday),
    daysLeft:dl, payday:s.payday, cycleStart:s.cycleStart,
    totalReservedCents:totalReserved, totalReservedFormatted:M(totalReserved),
    envelopes:envList, todaySpentCents:v3.todayTotal(s), todaySpentFormatted:M(v3.todayTotal(s)),
    thisWeekSpentCents:weekSpent, thisWeekSpentFormatted:M(weekSpent),
    thisMonthSpentCents:monthSpent, thisMonthSpentFormatted:M(monthSpent),
    weeklyPaceCents:dailyPace*7, weeklyPaceFormatted:M(dailyPace*7),
    cycleStats:{totalSpent:cySpent,totalSpentFormatted:M(cySpent),dailyAvg:Math.round(cySpent/cyDays),dailyAvgFormatted:M(Math.round(cySpent/cyDays)),txCount:cyTxC,daysInCycle:cyDays},
    dueEnvelopes, upcomingEnvelopes:upcoming,
    totalSavedCents:totalSaved, totalSavedFormatted:M(totalSaved), savingsEnvelopes:savingsEnvs,
    transactions:s.transactions.slice(-20).reverse(), monthlySnapshot:mSnap, checksumOk,
  };
}

const { runQuery: _runQuery } = require("./vera-v3-query");
function runQuery(state, query) { return _runQuery(state, query, computePicture, v3.toMoney); }

module.exports = { computePicture, runQuery };
