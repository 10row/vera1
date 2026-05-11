# Bug 0004 — Confirm buttons appearing on AI clarifying questions

## Symptom (user-reported)

> i need to get 200 euro budget for friend to store - how much will that affect

→ Bot replied: "reserving 200 euros for your friend - how long do you
need it for?" wrapped in **Log it / Skip** buttons.

Three things wrong simultaneously:

1. "How long do you need it for?" — this implies a LOAN, not a set-aside
   with a due date. The right question is "By when do you need to pay?"
2. Buttons on a question — what does "Log it" mean when the bot hasn't
   gathered enough info to log anything? "Skip" what?
3. AI routed `to store` → `ask_simulate`-shaped flow (Log it / Skip is
   the decision-flow keyboard) rather than `add_bill`. The commitment
   intent never reached the validator.

The user reported all three together: *"it asked me to log or skip it -
but its weird its asking how long ? --- and thats the other thing are
the buttons working ebcuase maybe it should ask me for the date its due
by or something whats teh AAA"*. The user named the root: should ask for
a date, not a duration.

## Technical layer

### What MUST be true for this symptom to occur?

Preconditions, in order:

P1. The AI's intent emission for "budget for friend to store" did NOT
    include a `dueDate`. ("To store" reads to gpt-4o-mini as
    "store/safekeep" — a custodial action without a clear due date.)

P2. The validator's old behavior on `add_bill` with no `dueDate` was a
    HARD REJECT with reason "Need a due date for X." Or — and this is
    the other branch — the AI didn't emit `add_bill` at all; it routed
    "200 euro" to ask_simulate's decision flow.

P3. Whichever path the AI chose, the bot's confirm card wrapped the
    output in buttons. The generic Yes/Cancel labels (and the decision
    flow's specific Log it/Skip labels) didn't carry the meaning of the
    question they were attached to.

P4. The user's input phrase "to store" was not in the AI prompt's
    commitment-vocabulary cue list. The prompt covered "save", "set
    aside", "reserve", "budget for" — but not "store", "hold", "park",
    "earmark", "stash".

### Why does each precondition hold?

- P1: The AI prompt example for `add_bill` says "When in doubt, USE
  recurrence: 'once'" and "ALWAYS need a dueDate. If user didn't give
  one, reply in TALK mode asking." But the AI is non-deterministic
  about WHICH path it takes — sometimes it emits add_bill without a
  dueDate (gambling that the bot will fill it in), sometimes it asks in
  talk mode, sometimes it routes to ask_simulate. We can't make the AI
  ONLY take one path. We need a bot-side safety net.

- P2: validator.js, case `add_bill`: `if (!dueDate) return reject(M(L,
  "billNeedsDueDate", { name }));` — a hard reject. The reject
  ultimately reaches the user with the reason string, wrapped in
  whatever buttons the bot's flow attaches to that outcome.

- P3: confirmKeyboard() was generic — same Yes/Cancel for every kind.
  When the validator hard-rejected, the bot's flow ALSO showed the
  rejection reason as a final-state error. Two paths through the code
  could surface buttons over text that wasn't a confirm.

- P4: The prompt's commitment vocabulary section was incomplete. "Store"
  and "hold" carry custodial semantics ("hold this for me") that map
  onto the same primitive (set-aside / add_bill once) but the AI didn't
  see them in the routing examples.

### Is there a single root that explains MULTIPLE symptoms?

YES. The shared root is **the validator has only two output states
(ok/error) but the bot has THREE UX outcomes (confirm-card,
plain-text-error, plain-text-question).**

The missing third state — `clarify` — is the architectural gap. When
the AI emits a well-formed intent but a required field is missing, the
correct UX is *"ask the user the missing piece, no buttons."* Without a
clarify shape:

- The hard-reject path was used to communicate missing fields. That
  feeds back into the same bot code paths that handle structural
  failures (dup name, past date) — both got error-like rendering.
- The bot's confirm-card path was used by ask_simulate's decision
  flow, which DOES show buttons. When AI mis-routed a commitment to
  ask_simulate (because it asked a clarifying question), the buttons
  came with it.
- The button labels were generic — even when correctly placed on a
  confirm card, "Yes" was ambiguous between "yes confirm the action"
  and "yes the answer to your question is yes."

The single root → multiple symptoms:
1. Confusing buttons on clarification questions
2. Generic "Yes" not telling the user what'll happen
3. AI sometimes routing commitments through ask_simulate
4. Validator's localized error message ("Need a due date for X") shown
   to users when the right UX is a friendly question

All four go away when validator returns a third verdict shape.

## Goal layer

### 3.5. What was the user TRYING to do?

Plausible goals when they wrote *"i need to get 200 euro budget for
friend to store - how much will that affect"*:

G1 (most common): **Set aside €200 they OWE a friend** by a known date,
   so the bot's pace math reflects the obligation. The "to store" word
   is colloquial — they mean "keep this money earmarked for the friend
   until I pay."

G2: **Check if €200 is affordable as a discretionary spend.** "How much
    will that affect?" is the give-away — they want to see the pace
    impact.

G3 (less likely): They want to LEND €200 to a friend and track when it
    comes back. (Not supported in current data model.)

### 3.6. Does the candidate fix serve the goal, or just patch the mechanism?

The bot's old behavior failed all three:
- G1: hidden behind a "how long" question that didn't match the mental
  model. The user needed to be asked "BY WHEN" — a date — not "for how
  LONG" — a duration.
- G2: AI mis-routed to ask_simulate. The pace-impact answer was lost.
- G3: Out of scope; bot can't help but should say so honestly.

The fix needs to make BOTH G1 and G2 work in one flow:
- G1: Validator returns clarify on missing dueDate. Bot asks "By when?"
  in plain text. User types "Friday". AI re-runs with dueDate filled
  in. Confirm card shows the bill + pace impact.
- G2: The confirm card for add_bill ALREADY shows the pace impact (see
  describeIntent / simulateAddBill). So G2 is answered AUTOMATICALLY
  when G1's flow completes. No separate path needed.

### 3.7. Which goal is most common AND most damaging when missed?

G1 — the set-aside intent — is most common (any "I need to pay X for Y
by Z" message). It's also most damaging when missed because the user
ASSUMED their data was captured. They moved on; the obligation never
made it into the pace math; days later they're short on rent because
the bot never reserved the €200 they meant to set aside.

G1 is the goal the fix MUST serve. Validator clarify + bot plain-text
question + AI commitment vocabulary all point at G1.

## Closeout

### 4. What assumption is forcing the conflict?

The architectural assumption was: *"every validator outcome is either
'good, show confirm card' or 'bad, show error.'"* That two-state model
forced ambiguous shapes (a missing field is neither "good" nor "an
error from the user's POV — it's a "I need more info").

Once we admit a THIRD outcome — "soft reject, ask the user for the
missing piece, no buttons" — the conflict dissolves. The bot has a
clean rendering path for each of its three UX states.

### 5. Negative branch — what could break?

NB1. **Existing tests assume `verdict.reason` is always a string on
    failure.** Fixed: clarify cases now route to `verdict.clarify` and
    explicit tests assert the new shape. Old hard-reject paths
    (dup name, past date) keep `verdict.reason`.

NB2. **Mini App callers (`/api/v5/action`, `/api/v5/apply`) might
    break if `verdict.reason` is undefined.** Fixed: both endpoints now
    fall back to `verdict.clarify.question` when `clarify` is set.

NB3. **do_batch with mixed clarify + valid items.** Old code would
    show valid intents in the confirm card and "skipped: <reasons>"
    beneath. With clarify, we surface the question for the first
    incomplete item instead. Decision: this is the right tradeoff —
    showing a confirm card while a sibling intent is incomplete leaves
    the user with a half-confirmed batch.

NB4. **Photo-receipt path with missing fields.** Now renders the
    clarify question as plain text rather than the "billNeedsDueDate"
    string. Receipts almost always have amount + date so this is rare.

## What variants pass

The unit-test surface added 8 new clarify tests + 14 button-label tests
(EN + RU). All 248 existing tests continue to pass. No live AI variants
were run (would require API key + harness); the fix is architectural
(validator shape) so AI variation is downstream.
