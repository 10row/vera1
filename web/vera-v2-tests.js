// ╔═══════════════════════════════════════════════════════════════════╗
// ║  VERA v2 — STRESS TESTS                                        ║
// ║  Tests the pure math engine with edge cases.                    ║
// ║  Run: node vera-v2-tests.js                                     ║
// ╚═══════════════════════════════════════════════════════════════════╝

"use strict";

// ── COPY OF CORE ENGINE (extracted from vera-v2.html) ────────────────

function toCents(usd) {
  if (usd === null || usd === undefined) return 0;
  const n = typeof usd === 'string' ? parseFloat(usd) : usd;
  if (isNaN(n) || !isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toUSD(cents) {
  if (cents === null || cents === undefined) return '$0.00';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const sign = neg ? '-' : '';
  return sign + '$' + dollars.toLocaleString() + '.' + String(remainder).padStart(2, '0');
}

let uidCounter = 0;
function uid() { return 'test_' + (++uidCounter); }
function today() { return '2026-04-25'; }
function d_key(name) { return (name ?? '').toLowerCase().trim(); }

function daysUntil(dateStr) {
  if (!dateStr) return 30;
  const t = new Date(today() + 'T00:00:00');
  const d = new Date(dateStr + 'T00:00:00');
  const diff = Math.ceil((d - t) / 86400000);
  return Math.max(1, diff);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.max(1, Math.ceil((db - da) / 86400000));
}

function todaySpent(state, poolKey) {
  const t = today();
  let cents = 0;
  for (const tx of state.transactions) {
    if (tx.date === t && tx.node === poolKey && tx.type === 'transaction') {
      cents += tx.amountCents;
    }
  }
  return cents;
}

function matchPool(state, description) {
  if (!description) return null;
  const lower = description.toLowerCase();
  let bestKey = null;
  let bestScore = 0;
  for (const [key, pool] of Object.entries(state.pools)) {
    if (!pool.active) continue;
    for (const kw of pool.keywords) {
      if (lower.includes(kw.toLowerCase()) && kw.length > bestScore) {
        bestKey = key;
        bestScore = kw.length;
      }
    }
    if (lower.includes(key) && key.length > bestScore) {
      bestKey = key;
      bestScore = key.length;
    }
  }
  return bestKey;
}

function createFreshState() {
  return {
    setup: false, balanceCents: 0, incomeCents: 0, savingsCents: 0,
    savingRateBps: 0, payday: null, cycleStart: null, currency: 'USD',
    currencySymbol: '$', localRate: 100, drains: {}, pools: {},
    transactions: [], conversationHistory: [],
  };
}

function applyAction(state, action) {
  if (!action || !action.type) return state;
  const s = JSON.parse(JSON.stringify(state));

  switch (action.type) {
    case 'setup': {
      const d = action.data;
      s.setup = true;
      s.balanceCents = toCents(d.balanceUSD);
      s.incomeCents = toCents(d.incomeUSD);
      s.savingRateBps = Math.min(10000, Math.max(0, Math.round((d.savingRate ?? 0) * 10000)));
      s.payday = d.payday ?? null;
      s.cycleStart = d.cycleStart ?? today();
      if (d.savingsUSD !== undefined) s.savingsCents = toCents(d.savingsUSD);
      s.transactions.push({ id: uid(), type: 'setup', amountCents: s.balanceCents, description: 'Initial balance', date: today(), ts: Date.now() });
      return s;
    }
    case 'add_drain': {
      const d = action.data;
      const key = d.name.toLowerCase().trim();
      s.drains[key] = { name: d.name, amountCents: toCents(d.amountUSD), frequency: d.frequency ?? 'monthly', nextDate: d.nextDate ?? null, autoPay: d.autoPay ?? false, paidThisCycle: false, active: true };
      return s;
    }
    case 'remove_drain': {
      const key = d_key(action.data.name);
      if (s.drains[key]) s.drains[key].active = false;
      return s;
    }
    case 'update_drain': {
      const d = action.data;
      const key = d_key(d.name);
      if (s.drains[key]) {
        if (d.amountUSD !== undefined) s.drains[key].amountCents = toCents(d.amountUSD);
        if (d.frequency !== undefined) s.drains[key].frequency = d.frequency;
        if (d.nextDate !== undefined) s.drains[key].nextDate = d.nextDate;
        if (d.autoPay !== undefined) s.drains[key].autoPay = d.autoPay;
      }
      return s;
    }
    case 'confirm_payment': {
      const key = d_key(action.data.name);
      if (s.drains[key] && !s.drains[key].paidThisCycle) {
        s.drains[key].paidThisCycle = true;
        s.balanceCents -= s.drains[key].amountCents;
        s.transactions.push({ id: uid(), type: 'bill_payment', amountCents: s.drains[key].amountCents, description: 'Bill: ' + s.drains[key].name, node: key, date: today(), ts: Date.now() });
      }
      return s;
    }
    case 'add_pool': {
      const d = action.data;
      const key = d.name.toLowerCase().trim();
      s.pools[key] = { name: d.name, type: d.type ?? 'daily', dailyCents: d.type === 'daily' ? toCents(d.dailyAmountUSD ?? 0) : 0, allocatedCents: d.type === 'monthly' ? toCents(d.allocatedUSD ?? 0) : 0, keywords: d.keywords ?? [], spentCents: 0, active: true };
      return s;
    }
    case 'remove_pool': {
      const key = d_key(action.data.name);
      if (s.pools[key]) s.pools[key].active = false;
      return s;
    }
    case 'transaction': {
      const d = action.data;
      const amountCents = toCents(d.amountUSD);
      if (amountCents === 0) return s;
      s.balanceCents -= amountCents;
      const poolKey = d.poolKey ? d_key(d.poolKey) : matchPool(s, d.description ?? '');
      if (poolKey && s.pools[poolKey] && s.pools[poolKey].active) {
        s.pools[poolKey].spentCents += amountCents;
      }
      const txType = amountCents < 0 ? 'refund' : 'transaction';
      s.transactions.push({ id: uid(), type: txType, amountCents, description: d.description ?? '', node: poolKey ?? 'free', date: today(), ts: Date.now() });
      return s;
    }
    case 'income': {
      const d = action.data;
      const amountCents = Math.max(0, toCents(d.amountUSD));
      const savingsDeduction = Math.round(amountCents * s.savingRateBps / 10000);
      s.savingsCents += savingsDeduction;
      s.balanceCents += (amountCents - savingsDeduction);
      if (d.nextPayday) s.payday = d.nextPayday;
      s.cycleStart = today();
      for (const key of Object.keys(s.drains)) { if (s.drains[key].active) s.drains[key].paidThisCycle = false; }
      for (const key of Object.keys(s.pools)) { if (s.pools[key].active) s.pools[key].spentCents = 0; }
      s.transactions.push({ id: uid(), type: 'income', amountCents, description: d.description ?? 'Income', date: today(), ts: Date.now() });
      return s;
    }
    case 'correction': {
      const newBalanceCents = toCents(action.data.amountUSD);
      s.balanceCents = newBalanceCents;
      s.transactions.push({ id: uid(), type: 'correction', amountCents: newBalanceCents, description: 'Balance correction', date: today(), ts: Date.now() });
      return s;
    }
    case 'set_saving_rate': {
      const rate = action.data.rate ?? 0;
      s.savingRateBps = Math.min(10000, Math.max(0, Math.round(rate * 10000)));
      return s;
    }
    case 'set_savings': {
      s.savingsCents = Math.max(0, toCents(action.data.amountUSD));
      return s;
    }
    case 'withdraw_savings': {
      const amt = toCents(action.data.amountUSD);
      s.savingsCents = Math.max(0, s.savingsCents - amt);
      s.balanceCents += amt;
      s.transactions.push({ id: uid(), type: 'savings_withdrawal', amountCents: amt, description: 'Savings withdrawal', date: today(), ts: Date.now() });
      return s;
    }
    case 'set_location': {
      const d = action.data;
      s.currency = d.currency ?? s.currency;
      s.currencySymbol = d.symbol ?? s.currencySymbol;
      s.localRate = d.localRate ? Math.round(d.localRate * 100) : s.localRate;
      return s;
    }
    case 'none': return s;
    default: return s;
  }
}

function computePicture(state) {
  if (!state.setup) return { setup: false };
  const dl = daysUntil(state.payday);
  const dic = state.cycleStart ? daysBetween(state.cycleStart, state.payday) : dl;
  const doc = Math.max(1, dic - dl + 1);

  let unpaidDrainsCents = 0;
  const drainsList = [];
  for (const [key, d] of Object.entries(state.drains)) {
    if (!d.active) continue;
    const unpaid = !d.paidThisCycle;
    if (unpaid) unpaidDrainsCents += d.amountCents;
    drainsList.push({ key, ...d, unpaid });
  }

  let poolReserveCents = 0;
  const poolsList = [];
  for (const [key, p] of Object.entries(state.pools)) {
    if (!p.active) continue;
    let totalAllocationCents;
    if (p.type === 'daily') {
      totalAllocationCents = p.dailyCents * Math.max(1, dl);
    } else {
      totalAllocationCents = p.allocatedCents;
    }
    const remainingCents = Math.max(0, totalAllocationCents - p.spentCents);
    poolReserveCents += remainingCents;
    poolsList.push({ key, ...p, totalAllocationCents, remainingCents });
  }

  const trulyFreeCents = state.balanceCents - unpaidDrainsCents - poolReserveCents;
  const freeTodayCents = dl > 0 ? Math.floor(trulyFreeCents / dl) : trulyFreeCents;
  const checksum = unpaidDrainsCents + poolReserveCents + trulyFreeCents;

  return {
    setup: true,
    balanceCents: state.balanceCents,
    savingsCents: state.savingsCents,
    savingRateBps: state.savingRateBps,
    trulyFreeCents,
    freeTodayCents,
    unpaidDrainsCents,
    poolReserveCents,
    daysLeft: dl,
    dayOfCycle: doc,
    daysInCycle: dic,
    drains: drainsList,
    pools: poolsList,
    checksumOk: checksum === state.balanceCents,
  };
}


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST HARNESS                                                    ║
// ╚═══════════════════════════════════════════════════════════════════╝

let pass = 0, fail = 0;
function assert(label, actual, expected) {
  if (actual === expected) { pass++; return; }
  if (typeof expected === 'number' && typeof actual === 'number' && Math.abs(actual - expected) < 0.5) { pass++; return; }
  fail++;
  console.log('FAIL:', label, '| got:', actual, '| expected:', expected);
}
function assertTrue(label, val) { assert(label, !!val, true); }
function assertFalse(label, val) { assert(label, !!val, false); }


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 1: toCents edge cases                                      ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── toCents edge cases ──');
assert('toCents(0)', toCents(0), 0);
assert('toCents(null)', toCents(null), 0);
assert('toCents(undefined)', toCents(undefined), 0);
assert('toCents("")', toCents(''), 0);
assert('toCents("abc")', toCents('abc'), 0);
assert('toCents(NaN)', toCents(NaN), 0);
assert('toCents(1)', toCents(1), 100);
assert('toCents(19.99)', toCents(19.99), 1999);
assert('toCents(0.01)', toCents(0.01), 1);
assert('toCents(0.001)', toCents(0.001), 0); // Sub-cent rounds to 0
assert('toCents(0.005)', toCents(0.005), 1); // Rounds up
assert('toCents(0.004)', toCents(0.004), 0); // Rounds down
assert('toCents(999999.99)', toCents(999999.99), 99999999);
assert('toCents(-10)', toCents(-10), -1000);
assert('toCents("19.99")', toCents('19.99'), 1999);
assert('toCents("0")', toCents('0'), 0);

// IEEE 754 trap: 0.1 + 0.2 = 0.30000000000000004
assert('toCents(0.1 + 0.2)', toCents(0.1 + 0.2), 30);

// Another IEEE trap: 29.99 * 100 = 2998.9999999999995
assert('toCents(29.99)', toCents(29.99), 2999);

// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 2: toUSD display                                           ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── toUSD display ──');
assert('toUSD(0)', toUSD(0), '$0.00');
assert('toUSD(100)', toUSD(100), '$1.00');
assert('toUSD(1999)', toUSD(1999), '$19.99');
assert('toUSD(1)', toUSD(1), '$0.01');
assert('toUSD(-500)', toUSD(-500), '-$5.00');
assert('toUSD(null)', toUSD(null), '$0.00');
assert('toUSD(undefined)', toUSD(undefined), '$0.00');
assert('toUSD(10000000)', toUSD(10000000), '$100,000.00');


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 3: Basic setup                                             ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Basic setup ──');
let s = createFreshState();
s = applyAction(s, { type: 'setup', data: { balanceUSD: 2000, incomeUSD: 5000, savingRate: 0.15, payday: '2026-05-15' } });
assertTrue('Setup complete', s.setup);
assert('Balance', s.balanceCents, 200000);
assert('Income', s.incomeCents, 500000);
assert('Saving rate', s.savingRateBps, 1500);
assert('Payday', s.payday, '2026-05-15');
assert('1 tx', s.transactions.length, 1);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 4: Setup with zero balance                                 ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Zero balance setup ──');
let z = createFreshState();
z = applyAction(z, { type: 'setup', data: { balanceUSD: 0, incomeUSD: 3000, savingRate: 0, payday: '2026-05-01' } });
assertTrue('Zero setup', z.setup);
assert('Zero balance', z.balanceCents, 0);
assert('Zero savings rate', z.savingRateBps, 0);
let zp = computePicture(z);
assertTrue('Zero checksum', zp.checksumOk);
assert('Zero trulyFree', zp.trulyFreeCents, 0);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 5: Drains (bills)                                          ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Drains ──');
s = applyAction(s, { type: 'add_drain', data: { name: 'Rent', amountUSD: 800, frequency: 'monthly', nextDate: '2026-05-01' } });
s = applyAction(s, { type: 'add_drain', data: { name: 'Gym', amountUSD: 50, frequency: 'monthly' } });
s = applyAction(s, { type: 'add_drain', data: { name: 'Netflix', amountUSD: 15.99, autoPay: true } });

assertTrue('Rent exists', s.drains['rent'] != null);
assert('Rent amount', s.drains['rent'].amountCents, 80000);
assert('Netflix amount', s.drains['netflix'].amountCents, 1599);
assertTrue('Netflix autoPay', s.drains['netflix'].autoPay);
assertFalse('Rent not paid', s.drains['rent'].paidThisCycle);

let pic = computePicture(s);
assert('Unpaid drains', pic.unpaidDrainsCents, 80000 + 5000 + 1599);
assertTrue('Checksum ok', pic.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 6: Confirm payment                                         ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Confirm payment ──');
const balBefore = s.balanceCents;
s = applyAction(s, { type: 'confirm_payment', data: { name: 'Gym' } });
assertTrue('Gym paid', s.drains['gym'].paidThisCycle);
assert('Balance after gym', s.balanceCents, balBefore - 5000);

// Double-confirm should NOT deduct again
const balAfterGym = s.balanceCents;
s = applyAction(s, { type: 'confirm_payment', data: { name: 'Gym' } });
assert('Double confirm no change', s.balanceCents, balAfterGym);

pic = computePicture(s);
assertTrue('Checksum after payment', pic.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 7: Pools (spending envelopes)                               ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Pools ──');
s = applyAction(s, { type: 'add_pool', data: { name: 'Food', type: 'daily', dailyAmountUSD: 20, keywords: ['food', 'lunch', 'dinner', 'restaurant', 'grocery', 'eat'] } });
s = applyAction(s, { type: 'add_pool', data: { name: 'Transport', type: 'monthly', allocatedUSD: 150, keywords: ['uber', 'taxi', 'bus', 'train', 'transport'] } });

assertTrue('Food pool exists', s.pools['food'] != null);
assert('Food daily', s.pools['food'].dailyCents, 2000);
assert('Food spent', s.pools['food'].spentCents, 0);
assert('Transport allocated', s.pools['transport'].allocatedCents, 15000);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 8: Transactions with pool matching                          ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Transactions ──');
const balBeforeTx = s.balanceCents;
s = applyAction(s, { type: 'transaction', data: { description: 'Lunch at restaurant', amountUSD: 15 } });
assert('Balance after lunch', s.balanceCents, balBeforeTx - 1500);
assert('Food spent', s.pools['food'].spentCents, 1500);

s = applyAction(s, { type: 'transaction', data: { description: 'Uber to work', amountUSD: 8.50 } });
assert('Transport spent', s.pools['transport'].spentCents, 850);

// Unmatched transaction → goes to free
s = applyAction(s, { type: 'transaction', data: { description: 'Random thing', amountUSD: 5 } });
assert('Free tx', s.transactions[s.transactions.length - 1].node, 'free');

pic = computePicture(s);
assertTrue('Checksum after txs', pic.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 9: Zero amount transaction (ignored)                        ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Zero transaction ──');
const balBeforeZero = s.balanceCents;
const txCountBefore = s.transactions.length;
s = applyAction(s, { type: 'transaction', data: { description: 'Free sample', amountUSD: 0 } });
assert('Zero tx no change', s.balanceCents, balBeforeZero);
assert('Zero tx no log', s.transactions.length, txCountBefore);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 10: Negative amount transaction (refund)                    ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Negative transaction (refund) ──');
s = applyAction(s, { type: 'transaction', data: { description: 'Refund?', amountUSD: -10 } });
assert('Neg tx = refund, balance increases', s.balanceCents, balBeforeZero + 1000); // -(-10) = +$10


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 11: Correction                                              ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Corrections ──');
s = applyAction(s, { type: 'correction', data: { amountUSD: 1500 } });
assert('Correction', s.balanceCents, 150000);

// Correct to zero
s = applyAction(s, { type: 'correction', data: { amountUSD: 0 } });
assert('Correct to zero', s.balanceCents, 0);

pic = computePicture(s);
assertTrue('Checksum zero', pic.checksumOk);
// trulyFree should be negative (drains + pools exceed zero balance)
assertTrue('Negative free', pic.trulyFreeCents < 0);

// Correct back
s = applyAction(s, { type: 'correction', data: { amountUSD: 1500 } });
assert('Correct restore', s.balanceCents, 150000);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 12: Income with savings deduction                           ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Income ──');
const savingsBefore = s.savingsCents;
const balBeforeIncome = s.balanceCents;
s = applyAction(s, { type: 'income', data: { amountUSD: 5000, description: 'Salary', nextPayday: '2026-06-15' } });

// 15% of $5000 = $750 → savings
const expectedSavingsAdd = Math.round(500000 * 1500 / 10000); // 75000 cents = $750
assert('Savings after income', s.savingsCents, savingsBefore + expectedSavingsAdd);
assert('Balance after income', s.balanceCents, balBeforeIncome + 500000 - expectedSavingsAdd);
assert('New payday', s.payday, '2026-06-15');

// Drains should be reset
assertFalse('Gym reset', s.drains['gym'].paidThisCycle);
// Pools spent should be reset
assert('Food spent reset', s.pools['food'].spentCents, 0);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 13: Income with zero savings rate                           ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Income zero savings ──');
s = applyAction(s, { type: 'set_saving_rate', data: { rate: 0 } });
assert('Rate zero', s.savingRateBps, 0);

const savBefore2 = s.savingsCents;
const balBefore2 = s.balanceCents;
s = applyAction(s, { type: 'income', data: { amountUSD: 1000, nextPayday: '2026-07-15' } });
assert('No savings added', s.savingsCents, savBefore2);
assert('Full income to balance', s.balanceCents, balBefore2 + 100000);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 14: Saving rate edge cases                                  ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Saving rate edges ──');
s = applyAction(s, { type: 'set_saving_rate', data: { rate: 1.0 } });
assert('100% rate', s.savingRateBps, 10000);

s = applyAction(s, { type: 'set_saving_rate', data: { rate: 0.001 } });
assert('0.1% rate', s.savingRateBps, 10);

s = applyAction(s, { type: 'set_saving_rate', data: { rate: 0 } });
assert('Back to zero', s.savingRateBps, 0);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 15: Savings withdrawal                                      ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Savings withdrawal ──');
s = applyAction(s, { type: 'set_savings', data: { amountUSD: 10000 } });
assert('Set savings', s.savingsCents, 1000000);

const balBeforeWith = s.balanceCents;
s = applyAction(s, { type: 'withdraw_savings', data: { amountUSD: 500, reason: 'Emergency' } });
assert('Savings after withdraw', s.savingsCents, 950000);
assert('Balance after withdraw', s.balanceCents, balBeforeWith + 50000);

// Withdraw more than savings → capped at 0
s = applyAction(s, { type: 'withdraw_savings', data: { amountUSD: 999999 } });
assert('Savings floored at 0', s.savingsCents, 0);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 16: Remove drain / pool                                     ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Remove nodes ──');
s = applyAction(s, { type: 'remove_drain', data: { name: 'Netflix' } });
assertFalse('Netflix deactivated', s.drains['netflix'].active);

s = applyAction(s, { type: 'remove_pool', data: { name: 'Transport' } });
assertFalse('Transport deactivated', s.pools['transport'].active);

pic = computePicture(s);
assertTrue('Checksum after removal', pic.checksumOk);
// Netflix should not be in unpaid drains
assertTrue('Netflix not in unpaid', !pic.drains.find(d => d.key === 'netflix'));


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 17: Null/undefined action safety                            ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Null/undefined safety ──');
const beforeNull = JSON.stringify(s);
let afterNull = applyAction(s, null);
assert('Null action', JSON.stringify(afterNull), beforeNull);

afterNull = applyAction(s, undefined);
assert('Undefined action', JSON.stringify(afterNull), beforeNull);

afterNull = applyAction(s, {});
assert('Empty action', JSON.stringify(afterNull), beforeNull);

afterNull = applyAction(s, { type: 'nonexistent_action', data: {} });
// Should not crash, just return state
assertTrue('Unknown action safe', afterNull != null);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 18: Pool matching                                           ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Pool matching ──');
assert('Match lunch', matchPool(s, 'Had lunch today'), 'food');
assert('Match eat', matchPool(s, 'Eating out with friends'), 'food');
assert('Match grocery', matchPool(s, 'Went to grocery store'), 'food');
assert('No match', matchPool(s, 'Bought new shoes'), null);
assert('Empty desc', matchPool(s, ''), null);
assert('Null desc', matchPool(s, null), null);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 19: Explicit poolKey override                               ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Explicit poolKey ──');
const spentBefore = s.pools['food'].spentCents;
s = applyAction(s, { type: 'transaction', data: { description: 'Something random', amountUSD: 5, poolKey: 'Food' } });
assert('Explicit poolKey', s.pools['food'].spentCents, spentBefore + 500);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 20: Massive transaction (stress)                            ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Massive transaction ──');
let big = createFreshState();
big = applyAction(big, { type: 'setup', data: { balanceUSD: 1000000, incomeUSD: 100000, payday: '2026-05-25' } });
big = applyAction(big, { type: 'transaction', data: { description: 'Buy car', amountUSD: 50000 } });
assert('Big tx', big.balanceCents, 95000000); // $950,000 in cents
let bigPic = computePicture(big);
assertTrue('Big checksum', bigPic.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 21: Rapid transactions (1000 in sequence)                   ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Rapid transactions (1000) ──');
let rapid = createFreshState();
rapid = applyAction(rapid, { type: 'setup', data: { balanceUSD: 100000, incomeUSD: 10000, payday: '2026-05-25' } });
rapid = applyAction(rapid, { type: 'add_pool', data: { name: 'Food', type: 'daily', dailyAmountUSD: 50, keywords: ['food'] } });

for (let i = 0; i < 1000; i++) {
  rapid = applyAction(rapid, { type: 'transaction', data: { description: 'food item ' + i, amountUSD: 1.50 } });
}
assert('1000 txs balance', rapid.balanceCents, 10000000 - (1000 * 150));
assert('1000 txs food spent', rapid.pools['food'].spentCents, 1000 * 150);
let rapidPic = computePicture(rapid);
assertTrue('Rapid checksum', rapidPic.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 22: Floating point traps                                    ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Floating point traps ──');
let fp = createFreshState();
fp = applyAction(fp, { type: 'setup', data: { balanceUSD: 100, incomeUSD: 1000, payday: '2026-05-25' } });

// Classic IEEE 754 problem: $0.10 + $0.20 should be $0.30
fp = applyAction(fp, { type: 'transaction', data: { description: 'a', amountUSD: 0.10 } });
fp = applyAction(fp, { type: 'transaction', data: { description: 'b', amountUSD: 0.20 } });
assert('0.10 + 0.20 = 0.30', 10000 - fp.balanceCents, 30); // Should be exactly 30 cents

// $33.33 × 3 should be $99.99, not $100.00 or $99.98
fp = applyAction(fp, { type: 'transaction', data: { description: 'c', amountUSD: 33.33 } });
fp = applyAction(fp, { type: 'transaction', data: { description: 'd', amountUSD: 33.33 } });
fp = applyAction(fp, { type: 'transaction', data: { description: 'e', amountUSD: 33.33 } });
assert('33.33 × 3', 10000 - fp.balanceCents, 30 + 9999); // 30 (prev) + 9999

let fpPic = computePicture(fp);
assertTrue('FP checksum', fpPic.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 23: Setup with existing savings                             ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Setup with savings ──');
let sv = createFreshState();
sv = applyAction(sv, { type: 'setup', data: { balanceUSD: 3000, incomeUSD: 6000, savingRate: 0.20, payday: '2026-05-15', savingsUSD: 15000 } });
assert('Initial savings', sv.savingsCents, 1500000);
assert('Savings rate', sv.savingRateBps, 2000);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 24: Update drain amount                                     ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Update drain ──');
s = applyAction(s, { type: 'update_drain', data: { name: 'Rent', amountUSD: 850 } });
assert('Updated rent', s.drains['rent'].amountCents, 85000);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 25: Waterfall integrity — balance = drains + pools + free   ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Waterfall integrity ──');

// Create a complex scenario
let w = createFreshState();
w = applyAction(w, { type: 'setup', data: { balanceUSD: 5000, incomeUSD: 8000, savingRate: 0.10, payday: '2026-05-20' } });
w = applyAction(w, { type: 'add_drain', data: { name: 'Rent', amountUSD: 1200 } });
w = applyAction(w, { type: 'add_drain', data: { name: 'Insurance', amountUSD: 200 } });
w = applyAction(w, { type: 'add_drain', data: { name: 'Phone', amountUSD: 45.99 } });
w = applyAction(w, { type: 'add_pool', data: { name: 'Food', type: 'daily', dailyAmountUSD: 25, keywords: ['food'] } });
w = applyAction(w, { type: 'add_pool', data: { name: 'Fun', type: 'monthly', allocatedUSD: 200, keywords: ['movie', 'game', 'bar'] } });

// Spend some
w = applyAction(w, { type: 'transaction', data: { description: 'food', amountUSD: 12 } });
w = applyAction(w, { type: 'transaction', data: { description: 'movie tickets', amountUSD: 30 } });
w = applyAction(w, { type: 'confirm_payment', data: { name: 'Phone' } });

let wp = computePicture(w);

// THE FUNDAMENTAL INVARIANT: balance = unpaidDrains + poolReserve + trulyFree
const invariant = wp.unpaidDrainsCents + wp.poolReserveCents + wp.trulyFreeCents;
assert('INVARIANT: balance = sum', invariant, wp.balanceCents);
assertTrue('Checksum flag', wp.checksumOk);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 26: Balance goes negative (overspent)                       ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Negative balance ──');
let neg = createFreshState();
neg = applyAction(neg, { type: 'setup', data: { balanceUSD: 50, incomeUSD: 3000, payday: '2026-05-01' } });
neg = applyAction(neg, { type: 'transaction', data: { description: 'Big purchase', amountUSD: 100 } });
assert('Negative balance', neg.balanceCents, -5000);
let negPic = computePicture(neg);
assertTrue('Neg checksum', negPic.checksumOk);
assertTrue('Neg trulyFree', negPic.trulyFreeCents < 0);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 27: Pool overspend (spent > allocated)                      ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Pool overspend ──');
let os = createFreshState();
os = applyAction(os, { type: 'setup', data: { balanceUSD: 1000, incomeUSD: 3000, payday: '2026-05-01' } });
os = applyAction(os, { type: 'add_pool', data: { name: 'Food', type: 'monthly', allocatedUSD: 100, keywords: ['food'] } });
os = applyAction(os, { type: 'transaction', data: { description: 'food', amountUSD: 150 } }); // Overspend by $50

assert('Overspent pool', os.pools['food'].spentCents, 15000);
let osPic = computePicture(os);
// Pool remaining should be clamped to 0, not go negative
const foodPool = osPic.pools.find(p => p.key === 'food');
assert('Pool remaining clamped', foodPool.remainingCents, 0);
assertTrue('Overspend checksum', osPic.checksumOk);
// The overspend should come out of trulyFree
assert('Free absorbed overspend', osPic.trulyFreeCents, os.balanceCents - 0); // pool reserve is 0


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 28: Location / currency                                     ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Location ──');
s = applyAction(s, { type: 'set_location', data: { currency: 'THB', symbol: '฿', localRate: 35.5 } });
assert('Currency', s.currency, 'THB');
assert('Symbol', s.currencySymbol, '฿');
assert('Rate stored', s.localRate, 3550);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 29: Multiple actions sequence integrity                     ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Multi-action integrity ──');
let m = createFreshState();
const actions = [
  { type: 'setup', data: { balanceUSD: 3000, incomeUSD: 6000, savingRate: 0.10, payday: '2026-05-15' } },
  { type: 'add_drain', data: { name: 'Rent', amountUSD: 1000 } },
  { type: 'add_drain', data: { name: 'Power', amountUSD: 80 } },
  { type: 'add_pool', data: { name: 'Food', type: 'daily', dailyAmountUSD: 20, keywords: ['food','eat','lunch'] } },
  { type: 'transaction', data: { description: 'lunch', amountUSD: 12 } },
  { type: 'transaction', data: { description: 'coffee', amountUSD: 4.50 } },
  { type: 'confirm_payment', data: { name: 'Power' } },
  { type: 'transaction', data: { description: 'random', amountUSD: 25 } },
];

for (const a of actions) { m = applyAction(m, a); }

let mp = computePicture(m);
assertTrue('Multi checksum', mp.checksumOk);

// Manual verification:
// Start: $3000
// Lunch: -$12 → $2988
// Coffee: -$4.50 → $2983.50
// Power: -$80 → $2903.50
// Random: -$25 → $2878.50
assert('Manual calc', m.balanceCents, 287850);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 30: Penny-perfect across many small transactions            ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Penny-perfect accumulation ──');
let pp = createFreshState();
pp = applyAction(pp, { type: 'setup', data: { balanceUSD: 100, incomeUSD: 1000, payday: '2026-05-25' } });

// 100 transactions of $0.99 each = $99.00 exactly
for (let i = 0; i < 100; i++) {
  pp = applyAction(pp, { type: 'transaction', data: { description: 'item', amountUSD: 0.99 } });
}
assert('Penny perfect', pp.balanceCents, 10000 - 9900);
assert('Exactly $1.00 left', pp.balanceCents, 100);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 31: computePicture on non-setup state                       ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── Non-setup picture ──');
let ns = createFreshState();
let nsp = computePicture(ns);
assertFalse('Not setup', nsp.setup);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  TEST 32: Income with 100% saving rate                            ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n── 100% saving rate ──');
let full = createFreshState();
full = applyAction(full, { type: 'setup', data: { balanceUSD: 0, incomeUSD: 5000, savingRate: 1.0, payday: '2026-05-01' } });
full = applyAction(full, { type: 'income', data: { amountUSD: 5000, nextPayday: '2026-06-01' } });
assert('Full savings', full.savingsCents, 500000);
assert('Zero to balance', full.balanceCents, 0);


// ╔═══════════════════════════════════════════════════════════════════╗
// ║  RESULTS                                                          ║
// ╚═══════════════════════════════════════════════════════════════════╝
console.log('\n════════════════════════════════════════');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail === 0) console.log('ALL TESTS PASSED');
else console.log('SOME TESTS FAILED');
if (fail > 0) process.exit(1);
