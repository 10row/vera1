# Bug candidates from olga

Overall score: **2/10** — _Critical currency handling bug rendered the bot unusable for a professional user; bot acknowledged the failure but could not resolve it, leading to complete task abandonment and support escalation._

## Strengths
- Maintained Russian language consistently throughout conversation
- Gracefully acknowledged systemic failure rather than denying it
- Offered reasonable escalation path (support contact) when unable to resolve
- Tone remained respectful and apologetic despite repeated failures

## Failures
- CRITICAL: Currency field hardcoded to USD ($) despite user explicitly specifying RUB (₽) four times across turns 1, 3, 7, 11
- Balance displayed as $120,000.00 in final state instead of 120,000 ₽ — confirms backend persistence bug
- Same USD bug replicated on bill creation (turn 20: $15,000.00 instead of 15,000 ₽)
- Daily budget calculation wrong twice: showed $12,000/day instead of ≈5,000 ₽/day
- Bot proposed corrections in plain text but UI confirmation buttons still rendered wrong currency — disconnect between intent layer and view
- No currency-switching mechanism or fallback UI offered despite user requesting it twice
- Turns 23–52: conversation devolved into repetitive goodbye loop, user clearly disengaged, bot kept engaging

## Bug candidates

## 1. Currency field hardcoded to USD in all data model outputs — high
- **Symptom:** User sets lang=ru and explicitly states balance in ₽, but bot renders all amounts (balance, daily budget, bills) as $ USD throughout conversation and in final state
- **Likely layer:** data_model|bot

## 2. Currency display not tied to user locale or explicit currency selection — high
- **Symptom:** Bot accepts currency correction in natural language (turn 3), acknowledges it in prose, but UI/state layer ignores it and continues rendering USD
- **Likely layer:** pipeline|view

## 3. Confirmation button text does not reflect corrected values — high
- **Symptom:** Bot says 'Исправляю баланс на 120 000 ₽' (turn 8) but button shows '$120,000.00'; user taps Да, but stored value remains $
- **Likely layer:** prompt|view

## 4. Daily budget calculation uses wrong divisor or ignores user salary input — high
- **Symptom:** User specifies 150,000 ₽/month → should be ~5,000 ₽/day; bot calculates 150k÷10 days = 15k/day, then displays $12,000/day
- **Likely layer:** bot|data_model

## 5. Repetitive goodbye loop not terminated — medium
- **Symptom:** From turn 29 onward, user signals intent to leave and contact support 8+ times; bot keeps re-engaging with near-identical acknowledgments instead of offering exit or stopping conversation
- **Likely layer:** bot|prompt
