# Bug candidates from mike

Overall score: **6/10** — _The bot successfully onboarded Mike and captured most setup intents (balance, bills, payday), but struggled with intent clarity on open-ended questions, dropped the College Fund bill from final state, and created unnecessary UX friction via repeated 'couldn't pin down' errors and surprise undo behavior._

## Strengths
- Clear, honest communication about feature limitations (no bank sync, no multi-account, no budget caps) — builds trust
- Correctly parsed and added three bills + payday with explicit confirmation flows
- Natural conversational tone; persona feels consistent throughout (casual, direct)
- Successfully logged the $87.43 grocery transaction and recalculated balance correctly
- Provided contextual runway math (post-bills cash, daily burn rate) that felt relevant to user needs

## Failures
- Final state shows only 2 bills (Mortgage, Car Payment) but conversation confirms 3 bills added + College Fund; Internet and College Fund are missing from balanceCents reconciliation
- Twice returned generic error 'I said I'd do it but couldn't pin down the exact action' in response to open-ended questions (turns 32, 38) — should have parsed conversational intent or asked for clarification naturally
- User tapped 'Undo' on turns 11, 21, 39, 55 with no clear trigger; bot state reverted but no explanation why user felt the need to undo (suggests bot confirmation UX was confusing or state didn't match expectation)
- Turn 42: bot claimed payday is 'tomorrow' (May 2nd) but also said bills are 'due by May 12th' — implied May 1st is today, but turn 4 already said payday is May 1st, creating timeline inconsistency
- College Fund bill was confirmed added (turn 52: balance dropped from $2,420 → $1,920/day after adding $500 bill), but missing entirely from final state JSON

## Bug candidates

## 1. Bill persistence failure on College Fund — high
- **Symptom:** User confirmed adding 'College Fund $500/month' bill; bot showed balance update ($2,420 → $1,920/day); but final state JSON omits the bill entirely
- **Likely layer:** data_model

## 2. Internet bill silently dropped — high
- **Symptom:** Turn 6: bot confirmed adding 'Internet $90 on the 20th'; turn 8: showed checkmark for all 3 bills; final state only includes Mortgage + Car Payment, not Internet
- **Likely layer:** data_model

## 3. Generic 'couldn't pin down' error on conversational queries — medium
- **Symptom:** Turns 32 & 38: user asked open-ended questions ('can you connect to my bank?' and a follow-up on payday math); bot returned template error instead of parsing intent or asking for specifics
- **Likely layer:** prompt

## 4. Unexplained Undo trigger on turns 11, 21, 39, 55 — medium
- **Symptom:** User repeatedly tapped 'Undo' with no clear cause (e.g., turn 11 after bot explained categories); no explanation in bot response; suggests user was confused by confirmation wording or state didn't feel correct
- **Likely layer:** view

## 5. Timeline inconsistency on payday and bill due dates — medium
- **Symptom:** Turn 4 says 'payday 2026-05-01'; turn 16 says 'next payday May 2nd'; turn 42 says 'bills due by May 12th' but also 'tomorrow' is payday — unclear if May 1 or May 2 is today
- **Likely layer:** bot

## 6. Transactioncount mismatch — low
- **Symptom:** Final state shows transactionCount: 1, but only one transaction was explicitly confirmed logged (turn 35: $87.43 groceries); College Fund bill was added but likely not counted as transaction
- **Likely layer:** data_model
