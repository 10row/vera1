# Bug candidates from carol

Overall score: **6.4/10** — _The bot handles core financial logic competently and maintains a warm, patient tone, but critical UX failures around accidental button presses and a data inconsistency on the streaming bundle due date severely undermine trust and create friction._

## Strengths
- Strong conversational voice — warm, patient, reassuring tone throughout
- Correct arithmetic on balance calculations across multiple transactions
- Graceful handling of user hesitation and self-correction (e.g., receipt verification)
- Proper confirmation flow before major actions (bills, spends)
- Clear, readable summary states with daily runway and upcoming bill alerts

## Failures
- Streaming Bundle due date inconsistency: logged as 2026-06-03 in turn [32] but rendered as 2026-05-03 in turn [40] and final state shows 2026-05-03 — date shifted backward one month
- Undo button placement/design causes repeated accidental triggers (turns [13], [37], [63], [71]) — user taps it when intending other actions, massive friction
- Bot does not proactively warn or guard against accidental undo — only reacts afterward
- No summary screen at setup completion showing all bills at once — user must verbally verify balance and math
- Bill totals mismatch final state: user entered mortgage $1,450 + escrow $380 + electric $120 + water $65 + phone $75 + streaming $44.99 = $2,134.99, but final state shows all amounts in cents with mortgage $145,000 (should be $145,000 ✓), electric $12,000 (should be $12,000 ✓), but these are correct — recalculation: $1450+$380+$120+$65+$75+$44.99 = $2,134.99 monthly; final state totals match ✓ Actually no error here

## Bug candidates

## 1. Streaming Bundle due date shifts one month backward — high
- **Symptom:** User adds streaming bundle due '3rd' in turn [31]; bot confirms 2026-06-03 in turn [32]; when re-added in turn [40], bot shows 2026-05-03; final state persists 2026-05-03
- **Likely layer:** data_model

## 2. Undo button too easy to trigger accidentally — high
- **Symptom:** User accidentally taps undo 4 times across turns [13], [37], [63], [71] — each requiring re-entry and confirmation. No protection or warning.
- **Likely layer:** view

## 3. No pre-confirmation bill summary at setup end — medium
- **Symptom:** After adding 6 bills, bot does not display a summary for user to verify all bills and amounts before declaring setup complete. User must manually verify via math.
- **Likely layer:** bot

## 4. Undo state message inconsistency — low
- **Symptom:** When undo is triggered, bot shows 'Undone.' but daily rate shown ($33.22) doesn't always match the immediately preceding or following state — minor drift in computed fields.
- **Likely layer:** pipeline
