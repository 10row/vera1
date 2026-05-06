# Bug candidates from carol

Overall score: **4/10** — _The bot captured most bill intents correctly but has a critical mechanical failure: it shows a $3,120 ending balance when the final state reveals $3,008 cents ($30.08). This discrepancy, combined with pervasive UX friction (expired confirmations, user confusion loops, repeated button taps), severely undermines trust despite reasonable conversational tone._

## Strengths
- Bill amounts and due dates captured accurately (6 bills, all correct cents values in final state)
- Consistent, reassuring tone throughout — matched persona's hesitant/careful style well
- Correctly inferred 'biweekly' from user saying '1st and 15th'
- Batch-added multiple bills (phone + water) without friction
- Polite, encouraging language ('take a breath; you're doing fine')

## Failures
- Balance tracking catastrophe: bot told user $3,008 after $112 spend, but final state shows $300,800 cents ($3,008.00) — this should have been $300,800 cents. User's $112 spend was logged but balance math appears inconsistent with final state representation.
- Expired confirmation loop: 'That confirm has expired' appeared 6+ times (turns 30, 34, 38, 42, 46, 50, 58, 62, 66, 70, 74, 78), creating friction and confusion; user repeatedly tapped 'Yes' buttons that no longer worked
- User repeatedly asked 'what's my balance' (turns 27, 43, 63, 67, 71, 75) because bot's prior responses created doubt; bot's reassurance was ineffective
- Spent $112 on groceries (turn 52) was captured, but user's confusion about exact amount ($11.20 vs $112) was not clearly resolved before confirmation

## Bug candidates

## 1. Balance representation mismatch — high
- **Symptom:** Bot showed user $3,008 balance (turn 54, 56, 64, 68) after $112 spend, but final state is $300,800 cents. User saw $3,008 and final state shows $3008.00 — values match in cents but user was confused about whether $3,008 was correct.
- **Likely layer:** data_model|bot

## 2. Expired confirmation buttons looping — high
- **Symptom:** After bot shows a confirmation (e.g., turn 28, 32, 40, 44, 48), user taps 'Yes' button and immediately gets 'That confirm has expired' message. This happened 12+ times in a row (turns 30–78), forcing user to ask questions instead of completing actions.
- **Likely layer:** view|pipeline

## 3. Transaction history not exposed — medium
- **Symptom:** User asked 'could you show me the last few transactions' (turn 71) and bot said 'I don't have a transaction history view yet' (turn 72). User needed this to debug balance confusion, but feature missing.
- **Likely layer:** onboarding|view

## 4. Initial payday inference mismatch — medium
- **Symptom:** User said 'the 15th' (turn 3), bot confirmed '2026-05-01' in turn 4, then immediately corrected to '2026-05-15 biweekly' in the same turn. Confusing UX — two dates shown for one action.
- **Likely layer:** prompt|bot

## 5. Spend amount ambiguity not resolved — low
- **Symptom:** User said '$112' but then second-guessed: '$11,200? No wait, $11.20? Oh my goodness, no — $112.' Bot logged $112 without asking clarification. User later doubted the balance, possibly because the input was ambiguous.
- **Likely layer:** prompt
