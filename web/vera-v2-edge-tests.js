// VERA v2 -- EDGE CASE STRESS TESTS
// Run: node vera-v2-edge-tests.js
"use strict";

function toCents(v){if(v==null)return 0;const n=typeof v==="string"?parseFloat(v):v;if(isNaN(n)||!isFinite(n))return 0;return Math.round(n*100)}
function toUSD(c){if(c==null)return"$0.00";const neg=c<0,a=Math.abs(c);return(neg?"-":"")+"$"+Math.floor(a/100).toLocaleString()+"."+String(a%100).padStart(2,"0")}
function today(){return"2026-04-25"}
let _uid=0;function uid(){return"t"+(++_uid)}
function dk(n){return(n??"").toLowerCase().trim()}
function safeDate(d){if(!d)return null;const dt=new Date(d+"T00:00:00");return isNaN(dt.getTime())?null:dt}
function daysUntil(d){if(!d)return 30;const t=safeDate(today()),target=safeDate(d);if(!t||!target)return 30;return Math.max(1,Math.ceil((target-t)/86400000))}
function daysBetween(a,b){const da=safeDate(a),db=safeDate(b);if(!da||!db)return 30;return Math.max(1,Math.ceil((db-da)/86400000))}
function normalizeDate(d){if(!d)return null;if(/^\d{4}-\d{2}-\d{2}$/.test(d)&&safeDate(d))return d;const dt=new Date(d);if(!isNaN(dt.getTime()))return dt.toISOString().slice(0,10);return null}

function matchPool(s,desc){
  if(!desc)return null;const l=desc.toLowerCase();let best=null,sc=0;
  for(const[k,p]of Object.entries(s.pools)){if(!p.active)continue;
    for(const kw of p.keywords){if(l.includes(kw.toLowerCase())&&kw.length>sc){best=k;sc=kw.length}}
    if(l.includes(k)&&k.length>sc){best=k;sc=k.length}}
  return best;
}

function fresh(){
  return{setup:false,balanceCents:0,incomeCents:0,savingsCents:0,savingRateBps:0,payday:null,cycleStart:null,drains:{},pools:{},transactions:[],history:[]};
}

function applyAction(STATE,action){
  if(!action||!action.type||action.type==="none")return STATE;
  const s=JSON.parse(JSON.stringify(STATE));const d=action.data||{};
  switch(action.type){
    case"setup":{
      s.setup=true;s.balanceCents=toCents(d.balanceUSD);s.incomeCents=toCents(d.incomeUSD);
      s.savingRateBps=Math.min(10000,Math.max(0,Math.round((d.savingRate??0)*10000)));
      let pd=d.payday?normalizeDate(d.payday):null;
      if(pd){const todayMs=new Date(today()+"T00:00:00").getTime();
        let dt=new Date(pd+"T00:00:00");
        while(dt.getTime()<=todayMs)dt.setMonth(dt.getMonth()+1);
        pd=dt.toISOString().slice(0,10)}
      s.payday=pd;s.cycleStart=d.cycleStart??today();
      if(d.savingsUSD!==undefined)s.savingsCents=toCents(d.savingsUSD);
      s.transactions.push({id:uid(),type:"setup",amountCents:s.balanceCents,description:"Initial balance",date:today(),ts:Date.now()});
      break;}
    case"add_drain":{
      const k=dk(d.name);if(!k)break;
      s.drains[k]={name:d.name,amountCents:toCents(d.amountUSD),frequency:d.frequency??"monthly",nextDate:d.nextDate??null,autoPay:d.autoPay??false,paidThisCycle:false,active:true};
      break;}
    case"remove_drain":{const k=dk(d.name);if(s.drains[k])s.drains[k].active=false;break;}
    case"confirm_payment":{
      const k=dk(d.name);if(s.drains[k]&&!s.drains[k].paidThisCycle){
        s.drains[k].paidThisCycle=true;s.balanceCents-=s.drains[k].amountCents;
        s.transactions.push({id:uid(),type:"bill_payment",amountCents:s.drains[k].amountCents,description:"Bill: "+s.drains[k].name,node:k,date:today(),ts:Date.now()});}
      break;}
    case"add_pool":{
      const k=dk(d.name);const kws=[d.name.toLowerCase()];const n=d.name.toLowerCase();
      if(n.includes("food")||n.includes("eat"))kws.push("food","lunch","dinner","breakfast","restaurant","grocery","eat","meal");
      if(n.includes("coffee")||n.includes("cafe"))kws.push("coffee","cafe","latte");
      if(n.includes("transport"))kws.push("uber","taxi","bus","train","transport","grab","bolt","ride");
      s.pools[k]={name:d.name,type:d.type??"daily",
        dailyCents:d.type==="daily"||!d.type?toCents(d.dailyAmountUSD??0):0,
        allocatedCents:d.type==="monthly"?toCents(d.allocatedUSD??0):0,
        keywords:[...new Set(d.keywords&&d.keywords.length?d.keywords.concat(kws):kws)],spentCents:0,active:true};
      break;}
    case"remove_pool":{const k=dk(d.name);if(s.pools[k])s.pools[k].active=false;break;}
    case"transaction":{
      const amt=toCents(d.amountUSD);if(amt===0)break;s.balanceCents-=amt;
      const pk=d.poolKey?dk(d.poolKey):matchPool(s,d.description??"");
      if(pk&&s.pools[pk]&&s.pools[pk].active)s.pools[pk].spentCents+=amt;
      const txType=amt<0?"refund":"transaction";
      s.transactions.push({id:uid(),type:txType,amountCents:amt,description:d.description??"",node:pk??"free",date:today(),ts:Date.now()});
      break;}
    case"income":{
      const amt=Math.max(0,toCents(d.amountUSD));const sav=Math.round(amt*s.savingRateBps/10000);
      s.savingsCents+=sav;s.balanceCents+=(amt-sav);
      if(d.nextPayday){let np=normalizeDate(d.nextPayday);if(np)s.payday=np}s.cycleStart=today();
      for(const k of Object.keys(s.drains))if(s.drains[k].active)s.drains[k].paidThisCycle=false;
      for(const k of Object.keys(s.pools))if(s.pools[k].active)s.pools[k].spentCents=0;
      s.transactions.push({id:uid(),type:"income",amountCents:amt,description:d.description??"Income",date:today(),ts:Date.now()});
      break;}
    case"correction":{
      s.balanceCents=toCents(d.amountUSD);
      s.transactions.push({id:uid(),type:"correction",amountCents:s.balanceCents,description:"Balance correction",date:today(),ts:Date.now()});
      break;}
    case"set_saving_rate":{s.savingRateBps=Math.min(10000,Math.max(0,Math.round((d.rate??0)*10000)));break;}
    case"set_savings":{s.savingsCents=Math.max(0,toCents(d.amountUSD));break;}
    case"withdraw_savings":{
      const amt=toCents(d.amountUSD);s.savingsCents=Math.max(0,s.savingsCents-amt);s.balanceCents+=amt;
      s.transactions.push({id:uid(),type:"savings_withdrawal",amountCents:amt,description:"Savings withdrawal",date:today(),ts:Date.now()});
      break;}
    case"set_location":{s.currency=d.currency??s.currency;s.currencySymbol=d.symbol??s.currencySymbol;break;}
  }
  return s;
}

function picture(s){
  if(!s.setup)return{setup:false};
  const dl=daysUntil(s.payday),dic=s.cycleStart?daysBetween(s.cycleStart,s.payday):dl,doc=Math.max(1,dic-dl+1);
  let unpaid=0;
  for(const[k,d]of Object.entries(s.drains)){if(!d.active)continue;if(!d.paidThisCycle)unpaid+=d.amountCents}
  let poolRes=0;
  for(const[k,p]of Object.entries(s.pools)){if(!p.active)continue;
    const total=p.type==="daily"?p.dailyCents*Math.max(1,dl):p.allocatedCents;
    poolRes+=Math.max(0,total-p.spentCents)}
  const free=s.balanceCents-unpaid-poolRes;
  const freeToday=dl>0?Math.floor(free/dl):free;
  return{setup:true,balanceCents:s.balanceCents,trulyFreeCents:free,freeTodayCents:freeToday,
    unpaidDrainsCents:unpaid,poolReserveCents:poolRes,daysLeft:dl,dayOfCycle:doc,daysInCycle:dic,
    checksumOk:(unpaid+poolRes+free)===s.balanceCents};
}

// -- TEST HARNESS --
let pass=0,fail=0,broken=[];
function assert(label,actual,expected){
  if(actual===expected||(typeof expected==="number"&&Math.abs(actual-expected)<1)){pass++;return}
  fail++;broken.push(label);
  console.log("FAIL:",label,"| got:",actual,"| expected:",expected);
}
function assertTrue(l,v){assert(l,!!v,true)}

function makeState(){
  let s=fresh();
  s=applyAction(s,{type:"setup",data:{balanceUSD:7000,incomeUSD:13000,savingRate:0.10,payday:"2026-05-25",savingsUSD:5000}});
  s=applyAction(s,{type:"add_drain",data:{name:"Rent",amountUSD:1237}});
  s=applyAction(s,{type:"add_drain",data:{name:"Gym",amountUSD:55}});
  s=applyAction(s,{type:"add_pool",data:{name:"Food",type:"daily",dailyAmountUSD:20,keywords:["food","lunch","dinner","coffee","juice","restaurant","eat","meal"]}});
  s=applyAction(s,{type:"add_pool",data:{name:"Transport",type:"daily",dailyAmountUSD:15,keywords:["uber","taxi","grab","bus","train","ride"]}});
  return s;
}

console.log("\n========================================");
console.log("  VERA v2 -- EDGE CASE STRESS TESTS");
console.log("========================================\n");

// == 1. REFUNDS ==
console.log("-- 1. REFUNDS --");
let s=makeState();
s=applyAction(s,{type:"transaction",data:{description:"Coffee and juice",amountUSD:13.75}});
assert("Coffee deducted",s.balanceCents,700000-1375);

s=applyAction(s,{type:"transaction",data:{description:"Refund: coffee",amountUSD:-13.75}});
assert("Refund via negative tx WORKS",s.balanceCents,700000);

s=applyAction(s,{type:"transaction",data:{description:"Free sample",amountUSD:0}});
assert("Zero tx ignored (correct)",s.balanceCents,700000);
console.log("  Refunds now work correctly.\n");

// == 2. AI SENDS WEIRD DATA ==
console.log("-- 2. AI SENDS WEIRD BUT REASONABLE DATA --");
s=makeState();
s=applyAction(s,{type:"transaction",data:{description:"Lunch",amountUSD:"12.50"}});
assert("String amount works",s.balanceCents,700000-1250);

s=applyAction(s,{type:"transaction",data:{description:"Something",amountUSD:5.999}});
assert("Extra decimals rounded",s.balanceCents,700000-1250-600);

s=applyAction(s,{type:"transaction",data:{amountUSD:3}});
assert("Missing description ok",s.balanceCents,700000-1250-600-300);

const beforeMissing=s.balanceCents;
s=applyAction(s,{type:"transaction",data:{description:"No amount"}});
assert("Missing amount no-op",s.balanceCents,beforeMissing);

s=applyAction(s,{type:"transaction",data:null});
assert("Null data no crash",s.balanceCents,beforeMissing);

s=applyAction(s,{type:"transaction"});
assert("No data no crash",s.balanceCents,beforeMissing);

s=applyAction(s,{type:"transaction",data:{description:"test",amountUSD:"NaN"}});
assert("NaN string no crash",s.balanceCents,beforeMissing);

s=applyAction(s,{type:"transaction",data:{description:"test",amountUSD:Infinity}});
console.log("  Infinity tx balance:",s.balanceCents,"(should not be -Infinity or NaN)");
const infBroken = !isFinite(s.balanceCents);
if(infBroken){fail++;broken.push("Infinity corrupts balance");console.log("  FAIL: Infinity corrupts balance!")}
else{pass++}

// == 3. BILL EDGE CASES ==
console.log("\n-- 3. BILL EDGE CASES --");
s=makeState();
const beforeBogus=s.balanceCents;
s=applyAction(s,{type:"confirm_payment",data:{name:"Electricity"}});
assert("Non-existent bill no-op",s.balanceCents,beforeBogus);

s=applyAction(s,{type:"confirm_payment",data:{name:"RENT"}});
assertTrue("Case-insensitive confirm",s.drains["rent"].paidThisCycle);

const afterRent=s.balanceCents;
s=applyAction(s,{type:"confirm_payment",data:{name:"Rent"}});
assert("Double confirm no double-deduct",s.balanceCents,afterRent);

s=applyAction(s,{type:"remove_drain",data:{name:"Gym"}});
s=applyAction(s,{type:"confirm_payment",data:{name:"Gym"}});
console.log("  Inactive bill confirm: paidThisCycle=",s.drains["gym"].paidThisCycle);

s=applyAction(s,{type:"add_drain",data:{name:"Free Service",amountUSD:0}});
assertTrue("Zero drain exists",s.drains["free service"]!=null);
assert("Zero drain amount",s.drains["free service"].amountCents,0);

s=applyAction(s,{type:"add_drain",data:{amountUSD:50}});
assertTrue("No-name drain rejected",!Object.keys(s.drains).includes(""));
console.log("  No-name drain key: rejected (correct)");

// == 4. POOL EDGE CASES ==
console.log("\n-- 4. POOL EDGE CASES --");
s=makeState();
s=applyAction(s,{type:"transaction",data:{description:"Huge lunch",amountUSD:500,poolKey:"Food"}});
assert("Pool overspend balance correct",s.balanceCents,700000-50000);
assert("Pool overspent amount",s.pools["food"].spentCents,50000);

s=applyAction(s,{type:"add_pool",data:{name:"Rent",type:"daily",dailyAmountUSD:10}});
assertTrue("Pool named Rent exists",s.pools["rent"]!=null);

s=applyAction(s,{type:"add_pool",data:{name:"Snacks",type:"daily",dailyAmountUSD:5,keywords:["food","snack"]}});
const snackMatch=matchPool(s,"food for thought");
console.log("  Keyword collision 'food' matches:",snackMatch,"(ambiguous is ok)");

// == 5. DATE EDGE CASES ==
console.log("\n-- 5. DATE EDGE CASES --");
let ds=fresh();
ds=applyAction(ds,{type:"setup",data:{balanceUSD:1000,incomeUSD:5000,payday:"2026-03-01"}});
assertTrue("Past payday normalized to future",ds.payday > today());
console.log("  Past payday '2026-03-01' -> normalized to:",ds.payday);

ds=fresh();
ds=applyAction(ds,{type:"setup",data:{balanceUSD:1000,incomeUSD:5000,payday:"2026-04-25"}});
assertTrue("Today payday pushed forward",ds.payday > today());
console.log("  Today payday -> normalized to:",ds.payday);

ds=fresh();
ds=applyAction(ds,{type:"setup",data:{balanceUSD:1000,incomeUSD:5000,payday:"the 25th"}});
console.log("  Weird payday 'the 25th' -> normalized to:",ds.payday);
const weirdPic=picture(ds);
assert("Weird date daysLeft fallback",weirdPic.daysLeft,30);

ds=fresh();
ds=applyAction(ds,{type:"setup",data:{balanceUSD:1000,incomeUSD:5000,payday:"May 25, 2026"}});
console.log("  'May 25, 2026' -> normalized to:",ds.payday);
assertTrue("Natural date parsed",ds.payday==="2026-05-25");

ds=fresh();
ds=applyAction(ds,{type:"setup",data:{balanceUSD:1000,incomeUSD:5000}});
const noPic=picture(ds);
assert("No payday defaults to 30 days",noPic.daysLeft,30);
assertTrue("No payday checksum ok",noPic.checksumOk);

// == 6. INCOME EDGE CASES ==
console.log("\n-- 6. INCOME EDGE CASES --");
s=makeState();
s=applyAction(s,{type:"set_saving_rate",data:{rate:1.0}});
const balBefore100=s.balanceCents;
const savBefore100=s.savingsCents;
s=applyAction(s,{type:"income",data:{amountUSD:5000,nextPayday:"2026-06-25"}});
assert("100% rate: nothing to balance",s.balanceCents,balBefore100);
assert("100% rate: all to savings",s.savingsCents,savBefore100+500000);

s=applyAction(s,{type:"set_saving_rate",data:{rate:0.10}});
const balBeforeZeroInc=s.balanceCents;
s=applyAction(s,{type:"income",data:{amountUSD:0}});
assert("Zero income no change",s.balanceCents,balBeforeZeroInc);

s=applyAction(s,{type:"income",data:{amountUSD:-1000}});
console.log("  Negative income: balance=",s.balanceCents,"savings=",s.savingsCents);
const negIncBroken = s.savingsCents < 0;
if(negIncBroken){fail++;broken.push("Negative income corrupts savings");console.log("  FAIL!")}
else{pass++;console.log("  (negative income clamped to 0 -- correct)")}

// == 7. CORRECTION EDGE CASES ==
console.log("\n-- 7. CORRECTION EDGE CASES --");
s=makeState();
s=applyAction(s,{type:"correction",data:{amountUSD:-500}});
assert("Negative correction",s.balanceCents,-50000);
const negPic=picture(s);
assertTrue("Negative balance checksum",negPic.checksumOk);

s=applyAction(s,{type:"correction",data:{amountUSD:9999999.99}});
assert("Huge correction",s.balanceCents,999999999);

s=applyAction(s,{type:"correction",data:{}});
assert("Empty correction = zero",s.balanceCents,0);

// == 8. SAVINGS EDGE CASES ==
console.log("\n-- 8. SAVINGS EDGE CASES --");
s=makeState();
s=applyAction(s,{type:"withdraw_savings",data:{amountUSD:999999}});
assert("Withdraw capped at zero",s.savingsCents,0);

s=applyAction(s,{type:"set_savings",data:{amountUSD:-1000}});
console.log("  Negative savings set to:",s.savingsCents);
const negSavings = s.savingsCents < 0;
if(negSavings){fail++;broken.push("Negative savings allowed");console.log("  FAIL!")}
else{pass++;console.log("  (capped at 0 -- correct)")}

s=applyAction(s,{type:"set_saving_rate",data:{rate:2.0}});
assert("200% rate capped to 100%",s.savingRateBps,10000);
s=applyAction(s,{type:"set_savings",data:{amountUSD:0}});
s=applyAction(s,{type:"correction",data:{amountUSD:1000}});
const balBeforeOver=s.balanceCents;
s=applyAction(s,{type:"income",data:{amountUSD:1000}});
console.log("  100% rate income: balance=",s.balanceCents,"savings=",s.savingsCents);
const overRateBroken = s.balanceCents < balBeforeOver;
if(overRateBroken){fail++;broken.push("Savings rate corrupts balance");console.log("  FAIL!")}
else{pass++;console.log("  (balance unchanged at 100% rate -- correct)")}

// == 9. CHECKSUM INTEGRITY ==
console.log("\n-- 9. CHECKSUM INTEGRITY --");
s=makeState();
let p=picture(s);assertTrue("Setup checksum",p.checksumOk);
s=applyAction(s,{type:"transaction",data:{description:"food",amountUSD:25}});
p=picture(s);assertTrue("After tx checksum",p.checksumOk);
s=applyAction(s,{type:"confirm_payment",data:{name:"Rent"}});
p=picture(s);assertTrue("After payment checksum",p.checksumOk);
s=applyAction(s,{type:"income",data:{amountUSD:13000,nextPayday:"2026-06-25"}});
p=picture(s);assertTrue("After income checksum",p.checksumOk);
s=applyAction(s,{type:"correction",data:{amountUSD:5000}});
p=picture(s);assertTrue("After correction checksum",p.checksumOk);
s=applyAction(s,{type:"remove_pool",data:{name:"Food"}});
p=picture(s);assertTrue("After pool removal checksum",p.checksumOk);
s=applyAction(s,{type:"remove_drain",data:{name:"Gym"}});
p=picture(s);assertTrue("After drain removal checksum",p.checksumOk);

// == 10. RAPID-FIRE ==
console.log("\n-- 10. RAPID-FIRE SEQUENCE --");
s=makeState();
const ops = [
  {type:"transaction",data:{description:"coffee",amountUSD:4.50}},
  {type:"transaction",data:{description:"lunch food",amountUSD:12}},
  {type:"transaction",data:{description:"uber ride",amountUSD:8}},
  {type:"confirm_payment",data:{name:"Gym"}},
  {type:"transaction",data:{description:"grocery food",amountUSD:35}},
  {type:"add_drain",data:{name:"Netflix",amountUSD:15.99}},
  {type:"transaction",data:{description:"taxi ride",amountUSD:6}},
  {type:"set_saving_rate",data:{rate:0.15}},
  {type:"transaction",data:{description:"dinner restaurant",amountUSD:22}},
  {type:"correction",data:{amountUSD:6800}},
];
for(const op of ops) s=applyAction(s,op);
p=picture(s);
assertTrue("Rapid-fire checksum",p.checksumOk);
assert("Rapid-fire balance",s.balanceCents,680000);
console.log("  Food spent:",s.pools["food"].spentCents/100,"(should be 73.50)");
assert("Food pool tracking",s.pools["food"].spentCents,7350);
console.log("  Transport spent:",s.pools["transport"].spentCents/100,"(should be 14)");
assert("Transport pool tracking",s.pools["transport"].spentCents,1400);

// == RESULTS ==
console.log("\n========================================");
console.log(pass+" passed, "+fail+" failed");
if(fail===0){
  console.log("ALL TESTS PASSED!");
}else{
  console.log("BROKEN THINGS:");
  for(const b of broken)console.log("  x "+b);
}
if(fail>0)process.exit(1);
