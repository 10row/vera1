# Vera / SpendYes — Working Protocol

**This file is read by Claude Code at session start. It is binding.**

You are working on a Telegram money bot. The user cannot inspect your
internal reasoning; they can only inspect the production bot. **Every
shipped fix must be defensible without their help.** This protocol
exists to make that possible.

---

## Bug-report protocol — non-negotiable

When the user reports a symptom (or you suspect one), do these in order.
**Skipping a step is a protocol violation. Document it if forced to skip.**

### 1. Reproduce locally first
```
node server/v5/harness/repro.js [--setup] [--balance=N] [--lang=en|ru] "<symptom text>"
```
- Captures: AI raw output, emitted intents, final state, transcript HTML.
- Writes artifacts to `bug-reports/_tmp/` by default.
- **If you cannot reproduce, you cannot fix.** Get more info from the
  user. Do not patch from a guess.

### 2. Goldratt root-cause analysis (in writing)
Before proposing a fix, answer these in
`bug-reports/<id>/01-goldratt.md`. The order matters — technical
analysis FIRST, then the goal layer, THEN the fix:

**Technical layer:**
1. **What MUST be true for this symptom to occur?** — list the
   preconditions. If you can't list them, you don't understand the bug.
2. **Why does each precondition hold?** — trace each through the layer
   it lives in (data model / validator / AI / pipeline / bot).
3. **Is there a single root that explains MULTIPLE symptoms?** — yes
   means you've hit the constraint. No means you're still on a
   downstream symptom.

**Goal layer (THE step that prevents symptom-fixes):**

3.5. **What was the user TRYING to do when they triggered the symptom?**
     Not what the bot did wrong — what the user wanted to ACHIEVE. List
     all plausible goals (often there are 2-3 different intents behind
     the same tap/message).

3.6. **Does the candidate fix serve the goal, or just patch the
     mechanism?** A fix that closes the technical gap but doesn't make
     the user's actual goal easier is half a fix.

3.7. **If multiple goals, which is most common AND most damaging when
     missed?** That's the one the fix MUST serve. The others are
     secondary. (Stress-test concept proved this in
     `bug-reports/_meta/goal-layer-stress-test.md`: "label the undo
     button" addresses anxious users but ignores the most-common
     "dismiss the hero" intent — the real fix decouples hero from
     undo.)

**Closeout:**
4. **What assumption is forcing the conflict?** — name the assumption.
   Is it actually true? (Often it isn't.)
5. **Negative branch — what could the proposed fix break?** — name 1+
   risk and the mitigation.

**Stop rules:**
- If the proposed fix doesn't also explain at least one *other*
  observed symptom, you may not be at the root. Re-run Q3.
- If you can't name the user's goal in 1 sentence, you don't understand
  what they wanted. Stop. Re-read the transcript. The fix you ship
  without G1 will likely solve a problem the user didn't have.

### 3. Variant explosion before shipping
```
node server/v5/harness/variants.js bug-reports/<id>
```
- Generates 10 paraphrases, runs each through the full pipeline.
- Pass rate must be ≥ 8/10 before you ship. Lower means the fix is
  brittle or you're at the wrong root.
- If a variant SHOULD fail (genuinely ambiguous input), document it
  in `bug-reports/<id>/expected.json` with a note.

### 4. Add a regression scenario
- Add a permanent scenario in `server/v5/harness/scenarios/` that
  reproduces the exact failure with `expected.intents[]` set.
- Run `node server/v5/harness/run-all.js <name>` and confirm green.

### 5. Only then ship
- Commit message references `bug-reports/<id>/`.
- Push. Tell the user:
  - what the root was (1 sentence)
  - what variant pass rate you hit (e.g. "10/10")
  - the new regression scenario name

**Never ask the user to test in production unless every step above is
green.** The protocol exists so the user is not your QA loop.

---

## Required artifacts per bug

Each bug gets a directory `bug-reports/<id>/` containing:

| File | What | Required |
|---|---|---|
| `01-goldratt.md` | Root-cause answers | YES |
| `02-repro-output.json` | Reproducer artifact | YES |
| `02-repro-transcript.html` | Visual transcript | YES |
| `03-variants.log` | Pass/fail per variant | YES |
| `expected.json` | Optional intent expectations | optional |

A commit that touches `server/v5/{ai,pipeline,bot,validator,model,view}.js`
without a matching `bug-reports/<id>/` from the last 24h is suspect.

---

## Project commands index

| Goal | Command |
|---|---|
| Run all unit tests | `node server/v5/tests/run.js` |
| Run all scenarios (LLM judge) | `node server/v5/harness/run-all.js` |
| Run scenarios skipping LLM | `node server/v5/harness/run-all.js --skip-llm` |
| Reproduce a bug | `node server/v5/harness/repro.js [opts] "<text>"` |
| Variant-test a bug | `node server/v5/harness/variants.js bug-reports/<id>` |
| 10-day simulation | `node server/v5/harness/long-sim.js --days=10 --checkpoint=3` |
| 100-day simulation | `node server/v5/harness/long-sim.js --days=100 --checkpoint=10` |

---

## Core logic — the mental model behind every number on screen

**Every audit MUST start here.** Most "weird math" bugs are violations
of one of these invariants. Memorize the model before patching.

### The cycle

A "cycle" is balance → next paycheck. Engine reserves money for bills
landing inside this cycle, divides the rest by days-to-payday for a
daily allowance, and freezes that allowance for the day.

### Money buckets (mutually exclusive, exhaustive)

```
balance
 ├─ obligated  = unpaid bills with dueDate ≤ payday  (reserved)
 └─ disposable = balance − obligated                 (yours to spend)
                  └─ daily pace = disposable / daysToPayday
                                  (FROZEN per day; recomputes on cycle events)
```

- `balance` — total in account. Banking number. Rarely the answer to
  any user question on its own.
- `obligated` — bills LANDING THIS CYCLE that are still unpaid.
  Excludes `paidThisCycle` and bills with `dueDate > payday` ("next
  cycle"). Sum lives in `state.bills` keyed by `billKey`.
- `disposable` — what's actually yours to spend before payday. THIS
  is the headline number for the hero, not balance.
- `dailyPace` — `floor(disposable / daysToPayday)`. Frozen per day;
  spending today eats `todayLeft = pace − todaySpent` but does NOT
  recompute the pace itself.

### Transaction kinds and what counts where

```
kind            balance  todaySpent  weekSpent  obligated   heatmap
─────────────  ───────  ──────────  ─────────  ──────────  ───────
setup           +full    no          no         no          no
correction      ±delta   no          no         no          no
spend (disc.)   −amt     YES         YES        no          YES
bill_payment    −amt     no          no         clears bill  no
income          +amt     no          no         no          no
deletedAt set   reverted no          no         restored*   no
```

- **`spend` is the ONLY thing counted as "today's discretionary"**
  (todaySpent / weekSpent / heatmap).
- **`bill_payment` is OBLIGATION money** — already reserved in
  `obligated`, NEVER counted as today's discretionary spend. Counting
  it would double-book: the user pays $1,400 rent, today's pace
  ($166/day) goes wildly negative, hero says "$0 left today,"
  variance chip says "$1,233 over today." User thinks they
  overspent; they didn't. They paid an obligation that was already
  set aside. (This bug shipped twice. Don't ship it a third time.)
- **Soft-deleted (`tx.deletedAt`) is filtered EVERYWHERE** that sums
  transactions: view.compute (today/week), buildHeatmap, dna.compute.
  delete_transaction reverses balance but keeps the row for audit.

### Cycle events (when frozen pace MUST refresh)

```
setup_account · adjust_balance · add_bill · remove_bill ·
update_payday · delete_transaction · undo_last
+ first event of a new day (rollover)
```

NOT cycle events (pace stays frozen):
```
record_spend (including bill_payment) · record_income (unless paycheck advances payday)
```

### Bill payment lifecycle (the trickiest path)

```
1. record_spend with billKey arrives
2. balance −= amount
3. SNAPSHOT prevDueDate + prevPaidThisCycle on the tx (for delete/undo)
4. if recurrence === "once":  paidThisCycle = true
   else:                       dueDate = addBillCycle(dueDate, recurrence)
                               paidThisCycle = false   (new cycle starts unpaid)
```

- Use **`addBillCycle`** (always advances by exactly one cycle), NOT
  `advancePayday` (only fast-forwards past today — early-pay no-op
  bug). They serve different purposes; don't substitute.
- If the new dueDate > payday, the bill silently moves to "next cycle"
  in obligation math — **this is correct behavior** and is surfaced
  to the user via the bills section subtitle ("$X next cycle").
- delete_transaction / undo_last for a bill_payment MUST restore both
  prevDueDate AND prevPaidThisCycle from the snapshot, then call
  refreshPace. Half-restored bills (paidThisCycle=false but dueDate
  still advanced) silently drop out of obligation math.

### Audit checklist (run before patching any "weird math" report)

When the user says "X looks wrong":

1. **Which bucket is wrong?** balance / obligated / disposable / pace
   / todaySpent — be precise. "$166 in account" and "$166 available"
   are different numbers.
2. **Trace the kind.** What `kind` is the offending transaction?
   `spend` vs `bill_payment` is the most common confusion source.
3. **Cycle events covered?** If the user did delete/undo/pay-bill,
   verify `refreshPace` fires AND bill snapshots are restored.
4. **Soft-delete poisoning?** Is the offending tx `deletedAt`-set but
   still being summed somewhere? grep for the loop and check the
   filter is `if (tx.deletedAt) continue`.
5. **Frozen pace stale?** If user just did a cycle event TODAY,
   `dailyPaceComputedDate === todayStr` should be true after the
   intent applies. If not, `refreshPace` was missed.

### Where the canonical math lives

- `server/v5/view.js` — `compute(state)` — the source of truth.
  EVERYTHING the user sees flows from here. If a number is wrong,
  this file is the first stop.
- `server/v5/engine.js` — `applyIntent(state, intent)` — the only
  thing that mutates state. Every intent path either calls
  `refreshPace` (cycle event) or doesn't (record_spend per Model B).
- `server/v5/index.js` — `v5ToV4View(state)` — the bridge to the
  Mini App. Adds short-formatted versions, cycle classifications,
  variance — but the math itself comes from `compute()`.

---

## Vera edges + things you've gotten wrong (do not repeat)

- **Onboarding is deterministic, not AI** (`server/v5/onboarding.js`).
  Parsers must handle EN + RU, including Cyrillic word boundaries.
- **v5 intents are sparse:** `setup_account`, `adjust_balance`,
  `add_bill`, `remove_bill`, `record_spend`, `record_income`,
  `update_payday`, `undo_last`, `reset`. Brain-dumps mentioning "save
  X for Y" / "$X budget for cat." have nowhere to land — data-model gap.
- **Mini App reads `d.view`/`d.recentTransactions`/`d.heatmap`** — not
  `d.pic`. Translation in `server/v5/index.js` `v5ToV4View()`.
- **Brain-dump capture re-routes the message** post-onboarding via
  `processText` OUTSIDE the lock (re-entering deadlocks).
- **`do_batch` shows ONE combined card** with single Yes-all (not v4's
  "Step N of M" wizard).
- **`/debug` returns last 5 raw AI responses** for that user.
- **Don't patch prompt without reproducing** — every "AI needs better
  rules" patch has been undone within 24h.
- **Don't treat data-model gaps as prompt problems** — when AI has
  nowhere to put a fact, no prompt fix saves you.
- **Don't ship at "unit tests pass"** — the unit tests are not the user.
  Variants are.
- **Don't ask the user to retest** — saying "try it now" = protocol
  failed. The variant tool tries it for you.

---

This protocol replaces "I think this fix should work." 30 seconds of
variant runs has saved hours of user back-and-forth in this codebase.
