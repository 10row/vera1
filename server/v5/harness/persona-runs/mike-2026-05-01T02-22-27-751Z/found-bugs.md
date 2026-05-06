# Bug candidates from mike

Overall score: **5/10** — _Bot captures user intents well and maintains conversational tone, but exhibits critical backend state management bugs that erode trust and create severe friction._

## Strengths
- Natural, empathetic voice — bot acknowledges limitations upfront and doesn't oversell
- Good intent capture — correctly parsed balance, payday, and 3 bills from freeform language
- Transparent about constraints — clearly stated what it can't do yet (bank sync, category limits, automated transfers, transaction editing)
- Helpful guidance — provided natural-language examples and patterns for interaction
- Honest debugging — when bugs surfaced, bot admitted visibility gaps rather than gaslighting

## Failures
- Undo operation fails silently — user undid payday changes 3 times (turns 13, 33, 43, 57), but state never reverted; display showed same burn rate and countdown each time, breaking user confidence
- State inconsistency on payday — bot set payday to 2026-05-08, then later corrected to 2026-05-10, but undo didn't roll back the 2026-05-10 update; final state shows reversion to 2026-05-08 after another undo
- Mechanical error in bill recording — final state shows only 2 bills (Mortgage $2,450, Car $385 = $283.50/day committed), but bot claimed to add 3 bills ($2,925/month = Internet $90 missing); turns 8–10 confirm Internet was added, but final state omits it
- Balance math divergence — bot calculated post-bill runway as $1,945/month available (turn 8: $11k biweekly = ~$24k/month; $24k - $2,925 = $21,075, not $1,945); suggests calculation error or data model inconsistency
- Undo semantics broken — bot has no visibility into whether undo actually works on backend (turn 36), yet keeps emitting undo confirmations; creates false sense of action completion
- User forced into manual workaround — after 3 failed undo attempts, bot had to ask user for original payday to force-correct via update_payday; indicates undo pipeline failure

## Bug candidates

## 1. Undo operation fails to revert state — high
- **Symptom:** User taps 'Undo: payday change' (turns 33, 43, 57); bot emits '✓ Undone' but screen shows identical balance, burn rate, and countdown; state never reverts
- **Likely layer:** data_model|pipeline

## 2. Bill Internet not persisted after batch add — high
- **Symptom:** Bot confirmed adding 3 bills in turn 10 with check marks; final state only contains Mortgage and Car payment; Internet missing from bills array
- **Likely layer:** data_model|pipeline

## 3. Payday undo reverts to stale value instead of previous state — high
- **Symptom:** User sets payday to 2026-05-10 (turn 52); state updates and burn rate recalculates correctly. User then undoes (turn 57); state reverts to 2026-05-08 (the first setting in turn 4), not to a neutral/original state
- **Likely layer:** data_model

## 4. Bot lacks backend state visibility for undo confirmation — high
- **Symptom:** Bot admits (turn 36) it cannot confirm whether undo worked on backend; continues to emit undo confirmations despite this blindness
- **Likely layer:** bot|pipeline

## 5. Monthly budget math inconsistency — medium
- **Symptom:** Bot states '$1,945/month after bills' (turn 8) but $11k biweekly (~$24k/month) minus $2,925 bills = $21,075 available, not $1,945; suggests wrong divisor or bill amount in calculation
- **Likely layer:** bot

## 6. Burn rate calculation doesn't account for missing Internet bill — medium
- **Symptom:** Post-fix burn rate of $345.71/day (turns 6, 10, 14) assumes only Mortgage + Car ($283.50/day + buffer), but Internet was supposed to be added; rates should differ if Internet is/isn't included
- **Likely layer:** bot|data_model
