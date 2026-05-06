# Bug candidates from carol

Overall score: **7/10** — _Bot handled a sensitive, patient onboarding well with warm tone and correct bill/balance math, but confusing undo behavior and ambiguous balance-tracking language created friction and user doubt._

## Strengths
- Excellent voice consistency—bot remained warm, patient, and encouraging throughout, matching user's apologetic/tentative tone
- Strong mechanical correctness on bill entry: all 6 bills captured with correct amounts (in cents: 145000, 38000, 12000, 6500, 7500, 4499) and due dates
- Good conversational quality—bot offered reassurance and avoided robotic repetition; natural pauses and affirmations
- Correct math on daily spending rate calculations and final balance reconciliation ($3,107.20)
- Handled transaction edit correctly (user changed $12.80 → $13.20 on groceries)

## Failures
- Undo button UX created confusion: turns 33–38 and 41–46 show user accidentally undoing bills twice, then needing them re-added; no confirmation or warning before undo executed
- Balance-tracking clarity failure: in turn 56, bot said balance is $3,094 after $13.20 spend from $3,120; but in turn 59 user questioned logic and bot said it had 'no record' of the undo—contradiction in state acknowledgment
- Turn 60 bot gaslighting: bot denies user undid the transaction (turn 57 clearly shows undo button tapped) then offers to undo it 'now', creating confusion about whether undo happened or not
- Expired confirm messages (turns 68, 72, 76): bot says 'That confirm has expired' after user taps Yes, suggesting UI state mismatch or stale button state—creates friction and appears broken
- Intent capture gap: user's tentative language ('I think that might've been…', 'let me double-check') not detected as uncertainty that might warrant confirmation or review step

## Bug candidates

## 1. Undo button lacks confirmation dialog — high
- **Symptom:** User accidentally undoes bills twice (turns 33, 41) with single tap; no 'are you sure?' prompt
- **Likely layer:** view

## 2. Undo state tracking inconsistency — high
- **Symptom:** Turn 57 user taps undo, turn 58 bot shows undone, but turn 60 bot claims 'I don't have a record' of the undo
- **Likely layer:** data_model

## 3. Confirmation button expires unexpectedly — high
- **Symptom:** Turns 68, 72, 76 show 'That confirm has expired' message after user taps Yes immediately; button should not expire mid-conversation
- **Likely layer:** bot

## 4. Balance communication ambiguity — medium
- **Symptom:** Turn 56 says 'Your balance is $3,094' (after spend) vs turn 32 said '$3,120 with $1,290 left'; user unsure if balance includes pending bills or not
- **Likely layer:** prompt

## 5. Missing edit/correction flow for tentative user inputs — low
- **Symptom:** Turn 47 user says 'let me think' and gives uncertain amount; bot accepts without offering 'are you sure?' or easy edit path
- **Likely layer:** prompt
