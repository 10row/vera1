# Bug candidates from carol

Overall score: **4/10** — _The bot captured most bills correctly but has critical mechanical flaws: it lost the streaming bundle from final state, miscalculates running balances, and the undo/redo UX is confusing and error-prone, creating excessive friction for a new user._

## Strengths
- Bot stayed in English throughout and maintained friendly tone
- Correctly parsed bi-weekly paycheck schedule on first mention
- Successfully captured 5 of 6 bills with correct amounts and due dates
- Bot showed patience during user's repeated accidental undos
- Clear confirmation messages for each bill added

## Failures
- CRITICAL: Streaming bundle ($44.99 due 2026-05-03) is missing from final bot state despite being confirmed by user in turns [67-70]
- Running balance display ($1,290/day) does not update after adding electric, water, phone, or streaming bills — only updates for mortgage and property tax
- Undo button is ambiguous: user cannot tell what action will be undone, leading to 6+ accidental undos by confused new user
- Bot claims in turn [76] 'streaming bundle is still there' but final state contains only 5 bills
- No visual bill summary or checklist to help user verify all bills are logged correctly

## Bug candidates

## 1. Streaming bundle persists in conversation but drops from persistent state — high
- **Symptom:** Bot confirms 'Streaming Bundle — $44.99 · 2026-05-03' in turn [70], user sees it logged. Final state has only 5 bills. Bot claims in turn [76] it's still there.
- **Likely layer:** data_model|pipeline

## 2. Running balance not recalculated for all bills — high
- **Symptom:** After adding electric ($120), water ($65), phone ($75), streaming ($44.99) in turns 56–70, the display still shows '$1,290.00/day' with only mortgage + escrow ($1,830) subtracted. Missing ~$305 in other bills.
- **Likely layer:** bot|view

## 3. Undo button semantics undefined for user — high
- **Symptom:** User taps undo after reading balance confirmation (turn 33, 41, 49, 73) thinking it's a 'dismiss' button. No clear label or affordance showing what action will be reversed. Causes 6 accidental undos.
- **Likely layer:** view|ux

## 4. Bot acknowledges undo but doesn't restate what was undone — medium
- **Symptom:** Turn [74] shows only 'Undone.' with no clarification of which bill. User confused about whether streaming bundle was removed. Bot later claims it's still there (turn 76).
- **Likely layer:** prompt|bot

## 5. No bill summary or list view for verification — medium
- **Symptom:** User asks multiple times 'what's my balance?' (turns 31, 39, 47, 55, 71) but never gets a clean list of all bills. Bot repeats total owed but never shows the itemized list in a single view.
- **Likely layer:** view
