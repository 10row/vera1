# 0002 — Russian onboarding: word-number balances rejected

User-reported: "russian language doesn't work."

Reproduced via repro.js: balance step fails for Russian users typing
"пять тысяч рублей" / "5к рублей" / "около пяти тыс". 1/6 baseline pass
rate on `--inline="у меня примерно пять тысяч рублей" --langs=ru`.

## Q1 — What MUST be true for this symptom to occur?

1. The user is in onboarding (state.setup === false).
2. They typed a balance using Russian word-numbers, "к"/"тыс" suffixes,
   or non-Latin script around digits.
3. `parseAmount(text)` returns `null` for those inputs.
4. Onboarding without a parsed amount stays in phase 1 — no progression.

## Q2 — Why does each precondition hold?

- (3) `parseAmount` has TWO Russian-killers in `server/v5/onboarding.js`:
  - **Tokenizer line:** `s.replace(/[^a-z\s]/g, " ")` strips Cyrillic
    BEFORE the word-number lookup. Even if WORD_NUMBERS had Russian
    entries, they could never match.
  - **WORD_NUMBERS table:** English-only. `"пять"`, `"тысяч"`, `"тыс"`
    not present.
  - **Suffix regex:** `(k|m|thousand|million|grand)`. No `"к"` (Cyrillic
    K), no `"тыс"`, no `"млн"`.

## Q3 — Single root explaining MULTIPLE symptoms?

YES: **the deterministic onboarding parser is monolingual at three
layers** (tokenizer, word-table, suffix-regex).

This single root explains:
- "пять тысяч рублей" rejected (word-numbers)
- "5к рублей" rejected (Cyrillic-K suffix)
- "около пяти тыс" rejected (тыс suffix + word-number)
- Russian payday parsing also has a thinner version of this issue
  (parsePayday handles "завтра"/"сегодня" but not "пятого"/"первого
  мая" date-by-word phrasings).

So fixing the parser to be multilingual at all three layers fixes a
class of bugs, not just one phrasing.

## Q4 — What assumption is forcing the conflict?

"AI will pick up what the parser misses." False — onboarding is
deterministic by design (no AI calls until state.setup is true).
There is no fallback. If the parser doesn't extract, the user is
stuck.

## Q5 — Negative branch reservation

| Risk | Mitigation |
|---|---|
| Russian word "пять" colliding with the *fifth-of-month* word "пятого" used in payday parsing | Test parsePayday with `--inline="пятого мая"` after the change to confirm no regression |
| Cyrillic "к" matching tokens that aren't suffixes | Anchor "к" only after digits (e.g. `(\d+)\s*к\b`) |
| Mixed scripts ("у меня 5k рублей") double-counting | Run regex digit-suffix first; only fall through to word-numbers if no digit match |

## Fix specification

In `server/v5/onboarding.js`:
1. Tokenizer: change `[^a-z\s]` → `[^a-zа-яё\s]` so Cyrillic survives.
2. WORD_NUMBERS: add Russian entries — `один`/`одна`/`два`/`две`/...,
   `десять`, `сто`, `тысяча`/`тысяч`/`тыс`, `миллион`/`млн`.
3. Suffix regex: add `к|тыс|тысяч|млн` alternates after digits.
4. Anchor "к" suffix to digit boundary so it doesn't match arbitrary
   Cyrillic-K words.

## Win condition

Variant pass rate ≥ 5/6 on `--inline="у меня примерно пять тысяч
рублей"` AND parsePayday tests for "пятого мая" / "пятнадцатого" still
return correct dates (no regression).
