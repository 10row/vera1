# Bug candidates from sam

Overall score: **6/10** — _The bot maintains excellent tone and voice but suffers from critical mechanical failures: dropped bill entries (phone), math inconsistencies, repetitive looping prompts, and poor handling of the undo/redo flow that leaves users confused about state._

## Strengths
- Excellent voice consistency — stays conversational, empathetic, and matches Sam's casual energy throughout
- Strong emotional support and judgment-free framing (tacos, weed gummies, roommate asks)
- Clear math transparency when offering spend scenarios (e.g., 'after that you'd have $273')
- Good intent to coach behavior (client follow-up, proactive roommate ask vs. panic-spiral)

## Failures
- Phone bill ($45/month on the 5th) was captured in turn [13] but never appears in final state — only 3 bills recorded instead of 4
- Rent amount mismatch: user said $950 split w/ roommates (so Sam's share unclear) but bot recorded $950 full; final state shows $95,000 cents = $950, but semantic ambiguity never resolved
- Turn [10] & [12]: bot repeats *exact same response* about 'skip' despite user already saying skip — suggests prompt loop or intent not recognized
- Undo/redo causes cascading confusion: turns [19]–[20], [29]–[30], [39]–[40], [51]–[52], [61]–[62] leave users unsure what persists (rent still shows after undo but taco spend doesn't — inconsistent model)
- Turn [42]: bot says 'Spend $15 · tacos' but user never said 'coffee' before — was coffee $15 or tacos $15? Label mismatch
- No income/invoice tracking offered despite user mentioning unpredictable freelance income multiple times — bot acknowledges but offers no solution (phone reminder is weak)
- Turn [46]: bot shows 'short $122' but user has $1,423 in account; math appears to assume rent + surgery immediate deduction but doesn't clearly show the sequential day-by-day burn before payday (confuses absolute balance with daily cushion)

## Bug candidates

## 1. Phone bill silently dropped from bill list — high
- **Symptom:** User explicitly said 'phone is 45 on the 5th' in turn [13], bot confirmed all 4 bills in turn [14], but final state only contains 3 bills (Rent, Insurance, Adobe). Phone never appears again.
- **Likely layer:** data_model

## 2. Repetitive skip-prompt loop (turns 10 & 12) — medium
- **Symptom:** User said 'skip' in turn [7], bot acknowledged in [8]. Then turns [9]–[11] user asks about bills repeatedly, and bot responds with *identical* 'No stress — just say skip' message twice, as if the skip wasn't registered.
- **Likely layer:** prompt

## 3. Undo state inconsistency — high
- **Symptom:** After undo in turn [19], rent bill persists on screen with full math ('Rent due tomorrow'), but user thinks they undid the bills. Then in [29] they undo again and the same confusion happens. Undo seems to only clear the *last* transaction, not the context user expected.
- **Likely layer:** bot

## 4. Negative balance math not clearly sequenced — medium
- **Symptom:** Turn [46] says 'short $122' before payday, but user has $1,423. The math is correct (1423 - 950 rent - 400 surgery = 73, then minus 195 in other bills = negative), but it's never shown step-by-step; user reads it as immediate insolvency rather than day-after-tomorrow problem.
- **Likely layer:** view

## 5. Missing income/invoice logging feature — medium
- **Symptom:** User mentions unpredictable freelance income in turns [5], [23], [33], [45], [55]. Bot acknowledges but offers no way to log incoming invoices, set payment reminders, or track expected income — only suggests a phone reminder (out-of-app).
- **Likely layer:** pipeline

## 6. Ambiguous spend label (turn 42) — low
- **Symptom:** User asks 'can i afford a 15 dollar coffee' in [41]. Bot says 'Logging those tacos' and shows 'Spend $15 · tacos', but user had previously mentioned both coffee AND tacos. Unclear if the $15 is for coffee or tacos or both.
- **Likely layer:** intent_capture
