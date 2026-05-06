# Bug candidates from mike

Overall score: **5/10** — _Bot handles onboarding and basic intent capture reasonably well, but critical mechanical failures (wrong bill amounts, undo button repeatedly broken, state not persisting) and extreme UX friction (user forced to re-setup payday 3x, accidental undos) severely undermine trust._

## Strengths
- Clear, honest communication about feature gaps (no bank sync, no category budgets, no 3-month history)
- Consistent persona — conversational, admits limitations upfront, doesn't oversell
- Correct biweekly paycheck recognition and explanation
- Bill tracking acknowledged and summarized clearly
- Transaction categorization (groceries, gas) captured and shown back to user

## Failures
- CRITICAL: Bill amounts stored incorrectly. User said 'mortgage $2,450' but final state shows $245,000 (100x error). User said 'car $385' but final state shows $38,500 (100x error). Internet bill ($89.99) added then undone — not in final state.
- CRITICAL: Undo button behaves erratically. User taps 'Undo: payday change' 3 times (turns 45, 53, 61) — bot responds 'Undone' each time but payday state appears unchanged in bot's own replies, yet user is forced to re-confirm setup. Suggests state is not persisting correctly or undo logic is broken.
- UX FAILURE: User accidentally hits undo twice (turns 27, 45, 53, 61) and has to re-confirm payday setup twice. No confirmation prompt on undo — too easy to fat-finger.
- MECHANICAL: Final state shows 'transactionCount': 2 (groceries $92.50, gas $58.75) but also shows 'eventCount': 15. Undo operations appear to be counted as events, making state tracking confusing.
- INTENT CAPTURE: User explicitly asked about Internet bill ($89.99 on the 20th) in turn [7]. Bot acknowledged it in turn [8], user confirmed in turn [9]. But final state has only Mortgage and Car Payment — Internet bill silently dropped after user's undo in turn [13].
- UX FRICTION: User undoes payday 3 times (turns 45, 53, 61) — suggests undo button is easy to hit by accident or unclear what it applies to. Bot does not prevent accidental destruction of important setup.
- MECHANICAL: Daily runway calculated inconsistently. Turn [10] shows '$345.71/day' after 3 bills added. Turn [24] after spending $151.25 shows '$324.10/day' — but final balance is $477,750 cents = $4,777.50, not $4,870 - $151.25 = $4,718.75. Numbers don't reconcile.

## Bug candidates

## 1. Bill amount parsing multiplies by 100 instead of storing cents — high
- **Symptom:** User entered 'mortgage $2,450' but final state shows 245000 cents ($2,450.00 display) — appears correct in UI but actual stored value is 100x the stated amount. Same for car: user said $385, stored as 38500.
- **Likely layer:** data_model

## 2. Undo state not persisting across turns — high
- **Symptom:** User taps 'Undo: payday change' in turn 45. Bot replies 'Undone' but turn 46 still shows payday as set. User has to re-confirm payday in turns 48–50. Same pattern repeats in turns 53–58 and 61.
- **Likely layer:** bot

## 3. Undo button lacks confirmation or rate-limiting — high
- **Symptom:** User accidentally taps undo 3 times during the conversation (turns 27, 45, 53, 61). No confirmation dialog, no recovery prompt. Extremely easy to wipe recent actions.
- **Likely layer:** view

## 4. Bill removed from state after undo but not acknowledged — medium
- **Symptom:** User added Internet bill $89.99 due 2026-05-20 in turn [8]. Confirmed in turn [9]. User then taps 'Undo: bill Internet' in turn [13]. Bot says 'Undone.' Final state contains only Mortgage and Car Payment — Internet silently dropped.
- **Likely layer:** bot

## 5. Daily runway calculation does not match balance delta — medium
- **Symptom:** Turn [24] shows balance $4,777.50 after spending $151.25 (started at $4,870). Daily rate shown as $324.10. But $4,777.50 / 7 days ≠ $324.10/day. Suggests either balance is wrong or burn rate is miscalculated.
- **Likely layer:** data_model

## 6. Confusing undo semantics — user cannot tell what will be undone — medium
- **Symptom:** Turn [27] user taps 'Undo: spend gas' but in turn [30] bot claims both gas and groceries are still logged. User gets confused about what undo actually did.
- **Likely layer:** view
