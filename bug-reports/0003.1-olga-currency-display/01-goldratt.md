# 0003.1 — RU users see "$" instead of "₽" everywhere

Found via persona harness (Olga, 2/10). The bot stored RU language flag
correctly but displayed every monetary amount in USD throughout
onboarding, hero, confirm cards, and final state.

## Q1 — Preconditions

1. User's Telegram client has `language_code` starting with `ru`.
2. Bot detects this on first message (commitTelegramLocale path).
3. State.language gets set to "ru" — but state.currency / state.currencySymbol stay defaults ("USD" / "$").
4. View + onboarding format amounts using state.currencySymbol → user sees "$".

## Q2 — Why each holds

- The locale-commit code in `bot.js` set `state.language` only — never touched currency fields.
- `createFreshState()` defaults to USD/$ regardless of detected locale.
- `onboarding.js` copy functions called `m.toMoney(amt)` with no symbol arg, defaulting to "$".

## Q3 — Single root explaining multiple symptoms? YES.

"Language commit doesn't carry currency forward, AND onboarding copy
defaults to '$' when no symbol is passed."

This single root explains:
- Olga sees `$120,000.00` after entering balance
- Confirm cards show `$` even after AI text says `₽`
- Final state.balanceCents stored in RUB amount but displayed in USD
- Daily-pace shown as `$12,000/day` instead of `₽12,000/день`

## Q4 — Forcing assumption

"Currency is independent of language." False — for the virgin user,
defaultCurrencyForLang gives a sensible default per locale; user can
override later.

## Q5 — Negative branch

| Risk | Mitigation |
|---|---|
| User on RU phone but actual currency is USD | They can override via update_settings: "switch to USD" |
| Currency switch mid-session for existing user | The fix only fires for `isVirgin` users (no setup, no events, no transactions) |
| Existing users with bad state | Old users have setup=true → isVirgin=false → fix doesn't fire. Their state is whatever they saved; explicit fix would need migration. Acceptable for now. |

## Fix

In `server/v5/bot.js`:
- `defaultCurrencyForLang(lang)` helper added inline.
- Locale commit branch now sets `state.currency` + `state.currencySymbol` from defaults when language changes for a virgin user.

In `server/v5/onboarding.js`:
- `handle()` derives `sym` from `state.currencySymbol` (with lang fallback).
- Threads `sym` through `copy.gotBalanceAskPayday`, `copy.allSet`,
  `copy.allSetSkipped`, all of which now use `m.toMoney(amt, sym)`.

## Win condition: met

| Metric | Before | After |
|---|---|---|
| Olga persona overall | 2/10 | **7/10** |
| Russian variant pass (`120000 рублей, зарплата 10-го`) | n/a | **6/6** |
| Onboarding reply currency | "$120,000.00" | "₽120,000.00" ✓ |
| Hero daily-pace currency | "$12,000/day" | "₽11,826.50/день" ✓ |
| 94 unit tests | passing | passing |
