# Bug candidates from alex

Overall score: **6/10** — _Bot handles basic transactions and voice well, but critical accounting errors (misinterpreting laptop purchase, payday math inconsistencies) and repeated undo/redo cycles undermine trust._

## Strengths
- Natural, casual tone matches user persona throughout
- Proactive affordability checks before major purchases
- Handles multi-transaction confirmations cleanly
- Clear confirmation summaries with balance updates

## Failures
- Turn 52: Bot interpreted 'laptop is $1,200' as user saying 'spend $10,117' (entire balance) — catastrophic input parsing failure
- Turns 19-22: User says 'logged groceries $65 yesterday' but bot treats it as pending transaction requiring confirmation, not a historical log
- Turn 62: Bot creates 'Japan trip savings' as a recurring bill/spend instead of a savings goal — conflates savings withdrawals with expenses, distorting runway math
- Payday math drifts: After turn 40, balance shows $9,717/day but user confirms $10,117 balance; later (turn 56) shows $9,717 after undo, then turn 60 shows $8,517 — inconsistent state across undo/redo
- Turn 28: Bot refuses to track savings goals, then immediately creates one in turn 62 without acknowledging the reversal

## Bug candidates

## 1. Amount parser confuses context — high
- **Symptom:** User says 'laptop is $1,200' and bot logs a $10,117 spend (the remaining balance). Bot misread the sentence as a direct amount.
- **Likely layer:** bot|pipeline

## 2. Historical transaction treated as pending — medium
- **Symptom:** User: 'logged groceries $65 yesterday' → Bot shows confirmation dialog requiring Yes/Cancel, implying it's a new transaction, not a retroactive entry.
- **Likely layer:** intent_capture|bot

## 3. Savings goal stored as recurring expense — high
- **Symptom:** Turn 62: 'Japan trip savings — $200.00 · monthly' added as a bill/spend, not a savings vehicle. This double-counts the $200 against available balance instead of ring-fencing it.
- **Likely layer:** data_model

## 4. Balance state corruption on undo/redo cycle — high
- **Symptom:** After turn 40 user confirms $10,117 balance, but subsequent undo (turn 43) shows $9,917, and after re-adding Japan fund (turn 48) shows $9,717. Math doesn't reconcile.
- **Likely layer:** data_model|pipeline

## 5. Inconsistent payday interval tracking — medium
- **Symptom:** Throughout conversation, '1 days to payday' persists even after payday supposedly hits (turn 37). Next payday should reset or advance.
- **Likely layer:** data_model

## 6. Savings goal capability flip-flopped — low
- **Symptom:** Turn 28 bot says 'I don't have dedicated savings goal tracker yet', but turn 62 creates one. No explanation for feature appearing mid-conversation.
- **Likely layer:** bot|prompt
