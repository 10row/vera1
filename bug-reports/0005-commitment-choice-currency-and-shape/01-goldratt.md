# Bug 0005 — Commitment-shaped spends: 3 bugs, 1 ROOT

## Symptom (user-reported)

1. *"didnt conver 200 euro to usd it just tried to reserve $200"*
   → User wrote `"i need to get 200 euro budget for friend to store"`.
   Bot proposed `add_bill` with `amountCents: 20000` (= $200), no
   conversion. The €→$ rate was silently lost.

2. *"didnt ask when i would be reserving for"*
   → User gave no date. The previous fix (0004) was supposed to surface
   a clarify question. Bot showed a confirm card with a guessed date
   anyway.

3. *"i spent 200 euro for my friends trip but if i write that it takes
   from my daily balance now?"*
   → User PAID the friend €200. Recording as `record_spend` eats
   today's discretionary allowance, even though it's a planned
   commitment that shouldn't dominate the "did I overspend today?"
   reading.

## Technical layer

### What MUST be true for each symptom?

**Symptom 1 (currency):**
- P1.1: AI emitted `add_bill` with `amountCents: 20000` (a USD value)
  and NO `originalAmount` / `originalCurrency`.
- P1.2: `pipeline.convertOnce()` is generic across intent kinds, but
  has nothing to convert when `originalCurrency` is missing.
- P1.3: AI prompt had foreign-currency examples under `record_spend`
  but **not under `add_bill`** — so the AI didn't transfer the
  pattern across intent kinds.

**Symptom 2 (silent date-guess):**
- P2.1: Validator's clarify path (shipped in 0004) catches MISSING
  `dueDate`. If AI invents a date, validator passes.
- P2.2: AI prompt was permissive: "ALWAYS need a dueDate. If user
  didn't give one, reply in TALK mode asking." gpt-4o-mini
  interpreted "ALWAYS need" as license to GUESS rather than OMIT.
- P2.3: No deterministic pipeline-side check that the user's message
  ACTUALLY mentioned a date.

**Symptom 3 (commitment-as-discretionary):**
- P3.1: `record_spend` (no `billKey`) is counted as today's
  discretionary by `view.compute`. Eating $200 of a $166/day
  allowance flips today's status to over.
- P3.2: No mechanism distinguishes "today's normal spending"
  (coffee, lunch, transport) from "one-time planned commitment"
  (gift, trip, deposit, wedding) — the AI treats both as
  `record_spend`.
- P3.3: The user's mental model is "this is a commitment, not my
  daily life" but the bot's data model has no surface for that.

### Single ROOT?

YES. All three symptoms come from one architectural gap: **the AI's
output shape is the same for THREE different user intents** —
discretionary spend, planned commitment, and recurring obligation —
but the bot's UX surface flattens them into one path (`do` →
confirm card). There's no moment where the user steers the
classification.

Fix: detect commitment SHAPE at the pipeline (amount + marker), then
offer the user a two-button choice. The buttons map to the two
correct data shapes (record_spend vs add_bill+bill_payment). One tap,
no jargon, both math models supported.

## Goal layer

### 3.5. User's actual goal

When typing *"i spent 200 euro for my friends trip"*:

- G1 (most common): **Track that I paid €200 toward a planned
  commitment so it shows in my history, but DON'T dominate today's
  pace** — paying a friend's trip isn't the same as having a $200
  day of overspending.
- G2: **Have the currency be right** — €200 ≠ $200, and the bot
  should know this without me having to flag it.
- G3: **Skip the "by when?" question** when the commitment is
  already-paid — there's no "by when" if the money already left.

### 3.6. Does the fix serve the goals?

- **G1** → commitment_choice card with "Commitment (won't eat
  daily)" option. Tap → batched `add_bill once + bill_payment`. Net:
  balance drops, bill clears, pace unchanged. EXACTLY the user's
  intent.
- **G2** → AI prompt now has foreign-currency examples under
  `add_bill`. Pipeline's `convertOnce` already worked across
  intents; it just needed the AI to emit `originalCurrency`.
- **G3** → the commitment batch sets `dueDate = today` (the bill is
  paid TODAY, not future). No clarify fires because dueDate is set.
  No friction.

### 3.7. Most damaging miss?

G1 — without the commitment-choice fix, every "I spent X for Y's
event" message creates a phantom overspending day in the user's
heatmap. Trust erosion: "the bot says I overspent but I didn't —
I was paying a commitment." This is the kind of error a money tool
cannot afford because the whole product premise is "do the math
right so I don't have to."

## Closeout

### 4. Assumption forcing the conflict

The architecture assumed: **"one intent kind = one user meaning."**
Reality: `record_spend` covers two distinct meanings (discretionary
vs paid-commitment), `add_bill` covers three (recurring, future
set-aside, just-paid commitment). The AI can't always disambiguate
from text alone.

Once we accept "one user phrasing → may need multiple intent shapes,
let the USER pick at the confirm moment," the conflict dissolves.
The commitment_choice card is the surface where the user steers.

### 5. Negative branch — what could break?

**NB1. False positives on the commitment card.**
If we fire on too many spends, the user gets card fatigue. Detection
is conservative: needs commitment marker (wedding/trip/gift/etc.) +
amount >= $30 AND >= 0.5× daily pace. A $25 coffee with "for the
trip" in the note won't fire. A $50 lunch with no marker won't fire.

**NB2. Stripping AI's dueDate when AI was right.**
The deterministic strip only fires on `recurrence: "once"` add_bills
when user message has NO date marker. Recurring bills' dueDates are
preserved. Fixed via the recurrence gate.

**NB3. Paired-token leak.**
A 2-option card creates 2 pending tokens. Tapping either MUST clear
the other (else delayed-tap silent double-apply). Fixed via
`pairedToken` field + sweep in `takePending`. Tests lock this in.

**NB4. Bill name derivation.**
"for friend's wedding" → "Friend's wedding" (keep named possessive).
"for the trip" → "Trip" (strip generic determiner). Tested 8 cases
EN + RU.

**NB5. Dup bill name in commitment batch.**
If user already has a bill called "Trip" and another commitment-
shape "Trip" lands, builder appends " (YYYY-MM-DD)" suffix.
Atomicity preserved.

## Stop rule check

The single root explains all three symptoms? YES (commitment shape
gap → forces wrong intent → cascade).

User goal nameable in 1 sentence? "Track my €200 friend's-trip
payment without it eating today's daily allowance."

## Variants

- Unit-test coverage: 40 new tests in `commitment.test.js`
  + 22 button-label tests + 8 paired-token tests.
- Integration: 292/292 unit tests pass.
- Live AI variants not run (would need API credits — user reported
  the quota was exhausted earlier today).
