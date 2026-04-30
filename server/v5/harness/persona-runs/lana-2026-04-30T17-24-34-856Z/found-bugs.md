# Bug candidates from lana

Overall score: **5/10** — _Bot captured core intents but exhibited critical currency display bugs, dropped transaction logging on first brain-dump, and created significant friction around a fundamental UX issue that should have been caught in onboarding._

## Strengths
- Conversational tone remained consistent and empathetic throughout currency frustration
- Bot correctly stored amounts in pence (base units) and math was internally sound
- Successfully escalated GBP display issue to support as user requested
- Handled bill rename/delete workaround (Gym → Equinox) smoothly
- Payday calculation and daily runway math remained consistent

## Failures
- Currency display bug: bot showed $ symbols for GBP amounts throughout entire session, contradicting user's setup in turn [1]
- Intent capture failure in turn [46]: brain-dump included 5 recent spends but bot only acknowledged balance + payday, skipped the 5 transactions, requiring user to re-submit in turn [49]
- Undo state management: turn [23] undo reverted to dollar display, suggesting state inconsistency between transaction layers
- Gym bill ghost state: turns [14]–[16] bot claimed Gym already existed even after user deleted it (turn [7]), forced workaround to Equinox
- Generic fallback responses in turns [36] and [42] broke conversational flow when user asked meta-questions about format

## Bug candidates

## 1. Currency display hardcoded to USD despite GBP storage — high
- **Symptom:** User set up in GBP (£12,400 balance, £1,650 rent) but bot displayed $ symbols throughout. User flagged in turn [9], bot acknowledged it was a backend display issue but couldn't fix it mid-session.
- **Likely layer:** view

## 2. Brain-dump transaction ingestion skips spends on first parse — high
- **Symptom:** Turn [45]: user pasted balance + payday + 4 bills + 5 recent spends. Turn [46] bot only logged balance + payday, skipped all 5 transactions (lunch, coffee, uber, drinks, book), required re-submission in turn [49].
- **Likely layer:** pipeline

## 3. Deleted bill persists in state after undo — high
- **Symptom:** Turn [7]: user confirmed deletion of Gym bill. Turns [14]–[16]: bot claims 'You already have a bill named Gym' despite deletion confirmation. Suggests undo didn't properly rollback bill state.
- **Likely layer:** data_model

## 4. Undo reverts view layer currency but not transaction context — medium
- **Symptom:** Turn [23]: user tapped Undo to revert Gym→Equinox. Turn [24] response shows $ symbols again, contradicting prior GBP context. Suggests undo state includes view formatting but loses currency context.
- **Likely layer:** bot

## 5. Generic fallback on meta-questions breaks intent capture — medium
- **Symptom:** Turns [36] and [42]: user asked procedural questions ('paste one message or split?', 'mention work vs personal?'). Bot responded with generic 'Try again with specific amount/date' error, ignoring the context and previous conversation.
- **Likely layer:** prompt

## 6. Currency setup not validated during onboarding — high
- **Symptom:** Turn [1]: user explicitly stated all amounts in GBP. Turn [2] onboarding showed $12,400.00 without converting or confirming currency. Currency mismatch went uncaught until turn [5].
- **Likely layer:** onboarding
