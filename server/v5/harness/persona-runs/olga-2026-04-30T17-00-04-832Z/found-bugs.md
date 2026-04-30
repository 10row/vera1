# Bug candidates from olga

Overall score: **7/10** — _Bot handles core financial logic well and maintains consistent Russian voice, but exhibits critical data state mismatches, allows duplicate transaction logging, and shows ambiguity around bill vs. expense boundaries._

## Strengths
- Consistent Russian language and warm, conversational tone throughout
- Correct arithmetic on balance calculations and daily spend rates (e.g., ₽11,875/day)
- Proactive safety check when user entered ₽250k medicines (caught likely typo)
- Clear confirmation UI pattern (preview → buttons → edit state)
- Reasonable delegation of features outside scope (reminders, Excel export)

## Failures
- CRITICAL: Bills stored at ₽1.5M, ₽80K, ₽60K (turn [10] final state) but user input was ₽15,000, ₽800, ₽600 — 100x scaling error on all three recurring bills
- CRITICAL: User attempts to log same ₽450 + ₽35 transactions twice (turns [7], [59]) — bot accepts both without deduplication check or warning
- Medicine bill added to state ([50]) but never confirmed in final state output — data integrity gap
- Turn [46] returns English error message ('That's more than your balance') in Russian-only conversation
- Ambiguous intent capture: turns [31], [39], [53] show 'Отменить' (undo) taps that appear context-free and reverse recent confirmations without user request
- Turn [20] promises goal-tracking help but bot has no goals subsystem — creates false capability expectation
- Daily spend rate unstable: ₽11,875 → ₽11,920 → ₽11,871.50 → ₽11,555 → cycles back to ₽11,875 despite confirmed transaction adds (suggests state rollback or calculation error)

## Bug candidates

## 1. Bill amount 100x scale error — high
- **Symptom:** User enters ₽15,000 rent; system stores ₽1,500,000. Same for internet (₽800 → ₽80,000) and mobile (₽600 → ₽60,000).
- **Likely layer:** data_model

## 2. Duplicate transaction acceptance — high
- **Symptom:** User logs ₽450 + ₽35 identical expenses at turns [7] and [59]; bot accepts both without dedup or user prompt.
- **Likely layer:** bot

## 3. Medicine bill missing from final state — high
- **Symptom:** Turn [50] confirms ₽25,000 medicines added; final state shows only 3 bills (rent, internet, mobile), not 4.
- **Likely layer:** data_model

## 4. Language code mismatch in error path — medium
- **Symptom:** Turn [46] returns English error message in Russian conversation: '_That's more than your balance — really ₽250,000.00?_'
- **Likely layer:** view

## 5. Unexplained undo confirmations — medium
- **Symptom:** Turns [31], [39], [53] show 'Отменить' (undo) without prior user input; reverses confirmed transactions.
- **Likely layer:** bot

## 6. Unstable daily spend rate calculation — medium
- **Symptom:** Daily rate swings: ₽11,875 → ₽11,920 → ₽11,871.50 → ₽11,555 → back to ₽11,875 despite monotonic transaction adds. Suggests state loss or incorrect aggregation logic.
- **Likely layer:** pipeline

## 7. False goal-tracking capability promise — low
- **Symptom:** Turn [20] bot says 'Цели пока не встроены' but offers detailed savings strategy, creating impression of feature support.
- **Likely layer:** prompt
