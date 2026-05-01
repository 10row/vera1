# 0003.4 — "Bills silently dropped" → really an Undo UX bug

## Originally reported as
"Phone bill / College Fund / Streaming Bundle confirmed in chat but missing from final state."
Hit 4 times across 3 personas (Sam, Mike, Carol).

## Q1 — What MUST be true?
- User confirmed an intent → engine applied → state updated.
- LATER, user tapped a button that triggered `undo_last`.
- That undo reversed the most-recent event, which happened to be the
  just-added bill.

## Q2 — Why?
The undo button label was just "Undo" — gave the user no idea what it
would undo. Personas tapped it as a generic "go back" / "dismiss the
hero" / "I'm confused" action. Each tap silently undid the most recent
applied intent, which was usually the bill they had just confirmed.

## Q3 — Single root explaining multiple symptoms?
YES: **the undo button has no semantic context.** Same root explains:
- Mike's College Fund (turn 41 add, turn 55 blind undo → gone)
- Sam's Phone bill loss (after multiple confused undos in turns 19-30)
- Carol's Streaming Bundle (after 6+ accidental undos)
- Why Mike's judge said "user repeatedly tapped undo with no clear cause"

## Q4 — Forcing assumption
"Users will only tap Undo when they truly want to undo." False — Telegram
has limited UI affordances; an unlabeled button gets used as a generic
back button by anxious users (Carol literally said "what does undo do?
let me try it" via her persona).

## Q5 — Negative branch
| Risk | Mitigation |
|---|---|
| Long descriptive label gets truncated by Telegram | Cap at 60 chars; Telegram supports ~64 on most clients |
| Russian labels overflow the cap | Russian descriptions are short ("счёт Аренда" = 12 chars) |
| Privacy: shows note text on undo button | Notes are user-typed; user already saw them. Acceptable. |
| Undo'ing actions chain — does each subsequent button show the right thing? | YES — `lastApplied` is recomputed for each newly-applied event |

## Fix
`server/v5/bot.js`:
- `undoKeyboard(eventId, lang, lastIntent)` now takes the intent that
  was just applied and produces a contextual label.
- `describeUndoTarget(intent, lang)` returns short noun phrases:
  "Undo: bill College Fund" / "Отменить: счёт Аренда" / "Undo: spend
  coffee" / etc.
- All call sites pass `lastApplied`.

## Win condition
- Re-run Mike persona → fewer than 4 random undos (judge will catch this)
- Re-run Carol persona → fewer than 6 accidental undos
- Final state contains all confirmed bills
