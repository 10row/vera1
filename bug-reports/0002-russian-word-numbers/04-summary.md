# 0002 — Russian onboarding: results

## Numbers

| Test | Pre-fix | Post-fix |
|---|---|---|
| RU balance-only word-numbers ("пять тысяч") | 1/6 | (correct — should not fire setup; goes to payday step) |
| RU full-onboarding (balance + payday in one message) | n/a | **8/8** |
| EN full-onboarding regression | n/a | **6/6** |
| `parsePayday("5 тыс рублей")` (false positive) | returned a date | returns null ✓ |
| `parsePayday("15-го мая")` | returned null | returns 2026-05-15 ✓ |
| `parsePayday("пятнадцатого")` | returned null | returns 2026-05-15 ✓ |
| `parsePayday("первого")` | returned null | returns 2026-05-01 ✓ |

## What was fixed

In `server/v5/onboarding.js`:

1. **WORD_NUMBERS** extended with Russian: `один`/`одна`/`два`/`две`/
   `пять`/.../`девяносто`/`сто`, `тысяч`/`тысяча`/`тыс`,
   `миллион`/`млн`. Masc + fem forms where money context distinguishes.
2. **Tokenizer** widened from `[^a-z\s]` to `[^a-zа-яё\s]` so Cyrillic
   letters survive into the word-number lookup.
3. **Suffix regex** in parseAmount widened to include `к` (Cyrillic-K),
   `тыс`/`тысяч`/`тысяча`/`тысячи`, `млн`. Anchored to digit boundary
   to prevent random matches.
4. **parsePayday strict mode** — bare digits no longer match
   day-of-month. Previously `"у меня 5000 рублей"` was returning
   `2026-05-05` because `\b\d{1,2}\b` matched `5`. Now requires explicit
   ordinal marker (en: st/nd/rd/th, ru: -го/-ое/числа) OR "the/on the"
   prefix.
5. **Russian ordinal-day words** added: `первого` … `тридцатого`. Uses
   Unicode property escape `\p{L}` lookarounds (not `\b`, which
   doesn't recognize Cyrillic word boundaries in JS).

## Negative branch — checked

| Risk | Outcome |
|---|---|
| Russian "пять" colliding with date word "пятого" | Distinct entries; tested both. ✓ |
| Cyrillic "к" matching arbitrary words | Anchored after digit (`\d+\s*к\b`). ✓ |
| Mixed scripts ("у меня 5k рублей") | Digit regex runs first; "5k" matches in either alphabet. ✓ |
| English regression | 6/6 on full English onboarding variants. ✓ |
| `parsePayday("5000")` false positive | Returns null. ✓ |

## Win condition: met
- 8/8 Russian variants in full-onboarding flow.
- 6/6 English regression.
- 0 false-positive payday matches in test set.
