# 0007 — Clarify loop + mark-paid double-show

## Symptoms (verbatim from user)

> "i try to set a bill and ti didnt work - 'iv egot my dry cleaning
> to pay tomorrow morning its 3150 thb - it replied bu when do you
> need it (a date friday 15th, in 3 weeks; "") ? and then i said
> tomoeeoq - then it replied the same hting... then i had the same
> response from 'today i paid dry cleaning'..."
>
> "also when i press mark as paid in the mini app for something - it
> marks it but the app still shows as its due and now for one its
> ays its overdue?"
>
> "im stressed bacese i dont knwo whats real now with my numbers."

Two distinct symptoms, two distinct architectural gaps:

1. **Clarify loop.** Bot asks "when?", user answers "tomorrow", bot asks
   "when?" again. Infinite loop.

2. **Mark-as-paid double-show.** Paid one-time bill appears in both
   "coming up / overdue" and "paid this cycle" simultaneously, with
   "overdue" label.

## Technical layer

### Q1. Preconditions

**Symptom 1 (clarify loop):**
1. AI emits `add_bill` without `dueDate` (non-deterministic — sometimes
   drops it even when "tomorrow" is in the message).
2. Validator returns a soft `clarify` for the missing `dueDate`.
3. Bot writes the question to chat and returns — **NOTHING is persisted
   on state**. No draft, no awaitingField, nothing.
4. User's reply "tomorrow" goes through `processMessage` as a brand-new
   turn. The AI sees the last 8 history messages and must reconstruct
   the full intent (name + amount + currency + recurrence) from
   conversation history. Stochastic.
5. AI fails to reconstruct → either talk-mode reply or partial intent →
   another clarify. Loop.

**Symptom 2 (mark-paid double-show):**
1. User marks a one-time bill paid via mini app → `record_spend` with
   `billKey` lands. Engine sets `paidThisCycle=true`, leaves `dueDate`
   unchanged.
2. Mini app reads `state.bills[X]` and renders THREE separate UI
   sections, each with their own urgency check:
   - `DueBanner` filter: `daysUntilDue <= 1` (forgets `paidThisCycle`)
   - `AnticipationStrip` filter: `daysUntilDue ∈ [0,7]` (forgets paid)
   - `BillCard` color + `dueDateLabel`: derived from `daysUntilDue`
     (forgets paid)
3. The paid section ("Paid this cycle") correctly filters by
   `paidThisCycle=true`.
4. Bill appears in BOTH the urgency-strip AND the paid section. The
   urgency-strip labels it "overdue" because `daysUntilDue < 0`.

### Q2. Why each holds

**Symptom 1:** there is NO clarify state machine. The bot's clarify
handler at `bot.js:960-964` writes the question and returns. The state
is saved before, not after, so even if pipeline mutated `state.pending*`
it wouldn't be persisted. This is the same "stateless between turns"
assumption that the deterministic backdate resolver was added to fix —
but only for past dates, not for clarify follow-ups.

**Symptom 2:** the bill envelope shape exposes `paidThisCycle`,
`daysUntilDue`, `cycleStatus` as separate raw fields. The view layer
adds a derived `isDue` but no consumer reads it. Each UI component
recomputes its own urgency from whichever subset of fields it remembers
to look at. Same data, three forgetful readers. The view contract has
no canonical "what's the UI status of this bill?" field.

### Q3. Single root → multiple symptoms

The two symptoms share a higher-order root: **canonical state isn't
crossing module/turn boundaries**.

- For clarify: the partial intent doesn't cross the turn boundary
  (state doesn't carry it).
- For mark-paid: the urgency decision doesn't cross the module boundary
  (each UI component decides for itself).

Both fixes are about exposing one authoritative field and making
consumers read from it.

## Goal layer

### Q3.5. What was the user TRYING to do?

Two goals:
1. **Log a future obligation** so it gets reserved out of the daily pace
   and the user doesn't lose track. ("Dry cleaning tomorrow 3150 thb.")
2. **Mark something paid** so the app stops nagging about it.

### Q3.6. Does the candidate fix serve the goal?

Yes for both:
1. `pendingDraft` mechanism — "tomorrow" reply now deterministically
   resolves to the bill's due date without the AI needing to remember
   the rest of the context.
2. Canonical `uiStatus` field — every UI consumer reads ONE field; a
   paid bill is `uiStatus: "paid"` and never gets a red/amber urgency
   label or shows up in the "coming up" strip.

### Q3.7. Most common AND most damaging?

Both are flagship-quality failures. The user explicitly said
"im stressed bacese i dont knwo whats real now with my numbers." The
bot's job is to give the user ONE reliable picture. These two bugs
broke that promise in opposite ways:
- Clarify loop: the bot makes you re-type the same thing.
- Mark-paid double-show: the bot tells contradicting stories about
  the same bill.

## Closeout

### Q4. What assumption is forcing the conflict?

- **Clarify:** "The AI will reliably reconstruct the partial intent
  from conversation history." It won't.
- **Mark-paid UI:** "Every UI component can decide for itself what
  urgency a bill has, from raw fields." It can't — three did, three
  forgot something.

### Q5. Negative branch — what could the fix break?

- `pendingDraft` is mutable state. If a stale draft survives a crash
  or expires badly, user could see a phantom clarify next session.
  Mitigations: 10-min wall expiry, 3-turn count cap, clear on any
  successful `do`/`do_batch`, clear on `/reset` (via createFreshState).
- `pendingDraft` runs BEFORE the status-question short-circuit. A user
  in clarify who types "today" gets the date merged instead of the
  status snapshot. **Intended** — they're answering a question, not
  asking one. Test locked.
- `uiStatus` is purely derived. No new mutation. No engine change. No
  symmetry-invariant risk (refresh-pace IFF apply did).
- Removal of `isDue` field — verified no consumer reads it.

## Fix plan (shipped)

1. **server/v5/model.js** — add `pendingDraft: null` to `createFreshState`.
2. **server/v5/pipeline.js** —
   - Add `FORWARD_DATE_RESOLVERS` (sibling to backdate resolvers).
   - Add `resolveForwardDateFromText`, `resolvePendingField`,
     `tryResolvePending`, `makePendingDraft`.
   - PHASE 1.5: pending-draft resolution BEFORE status check and AI call.
   - PHASE 1.6: status check (moved down).
   - When emitting `kind:"clarify"`: set `state.pendingDraft`.
   - When emitting `kind:"do"/"do_batch"`: clear `state.pendingDraft`.
3. **server/v5/bot.js** — clarify path now calls `saveState` so
   `pendingDraft` persists between turns.
4. **server/v5/view.js** — new `computeBillUiStatus(b, daysUntilDue,
   cycleStatus)` helper exported.
5. **server/v5/index.js** — envelopes include `uiStatus`; remove dead
   `isDue` field.
6. **miniapp/vera-v4.js** — `DueBanner`, `AnticipationStrip`,
   `BillCard` color, `dueDateLabel`, soonBills, next-cycle chip ALL
   switched to read `uiStatus`. No more daysUntilDue-only filters.
7. **server/v4/locales/en.js + ru.js** — add `miniapp.bills.due.paid`.
8. **server/v5/ai.js** — add "tomorrow" / "сегодня" / "tomorrow morning"
   examples to the add_bill date-extraction rules.

## Tests (shipped)

- `server/v5/tests/bills-uistatus.test.js` — 18 tests covering the
  full cross-product of (paidThisCycle, daysUntilDue, cycleStatus) →
  uiStatus, plus integration tests for one-time + recurring mark-paid
  + undo restore.
- `server/v5/tests/pending-draft.test.js` — 39 tests covering forward-
  date resolution (EN + RU), per-field resolvers (dueDate, amount,
  recurrence, name), tryResolvePending dispatcher (expired/miss/
  resolved), and end-to-end through processMessage including the exact
  dry-cleaning multi-turn flow.
- `server/v5/harness/scenarios/14-clarify-loop-dry-cleaning.js` — real
  AI end-to-end "need to pay dry cleaning 3150 thb / tomorrow / yes".
- `server/v5/harness/scenarios/15-mark-paid-no-double-show.js` —
  chat-side smoke for bill add (mark-paid invariant fully covered
  by integration unit tests).

**Full suite: 496/496 unit tests + 15/15 scenarios green.**

## Stop-rule check

- Single root explains > 1 symptom? **Yes** — both symptoms reduce to
  "canonical state isn't crossing a boundary."
- Negative branch identified + mitigated? **Yes** — see Q5.
- Goal sentence clear? **Yes — log a future obligation; stop nagging
  about a paid bill.**

Shipped after 496/496 + 15/15 green.
