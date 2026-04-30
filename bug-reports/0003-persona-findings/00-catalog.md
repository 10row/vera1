# 0003 — Persona-test bug catalog (3 personas × 20 turns)

Source: `server/v5/harness/persona-runs/{alex,olga,sam}-*` from 2026-04-30.

| Persona | Score | Top bugs |
|---|---|---|
| Alex (EN, dev) | 6/10 | amount parser misread, savings as bill, balance corruption on undo |
| **Olga (RU, accountant)** | **2/10** | **currency display hardcoded $ ignoring RUB** (CRITICAL) |
| Sam (EN, designer) | 6/10 | phone bill silently dropped, skip-loop, undo state inconsistency |

## Critical (fix first)
- **0003.1** Currency display ignores `state.currency` — `$` shown to RUB user across hero, confirm cards, final state. (Olga, all turns)

## High-priority data model gaps
- **0003.2** Savings goals stored as recurring bills (Alex turn 62 + Sam panic) — no `add_goal`/`add_envelope` intent.
- **0003.3** Income context dropped — Alex/Sam mention "freelance income / monthly salary"; bot has nowhere to store it (matches earlier income bug).
- **0003.4** Phone bill silently dropped in batch confirm (Sam: 4 bills mentioned, 3 stored).

## Bot/UX issues
- **0003.5** Amount parser confuses context — "laptop is $1,200" logged as $10,117 (Alex turn 52).
- **0003.6** Historical-log intent ("logged groceries yesterday") treated as pending confirm (Alex turn 19).
- **0003.7** Skip command not always recognized — bot loops on "no stress just say skip" (Sam turn 10/12).
- **0003.8** Undo state inconsistency — partial undo leaves UI in half-state (Alex + Sam).
- **0003.9** Goodbye-loop — bot keeps replying after user clearly disengages (Olga turns 29-52).

## Math / view
- **0003.10** Daily-pace divisor wrong post-payday-reset (Alex `1 days to payday` persists).
- **0003.11** Negative-runway math not sequenced clearly (Sam turn 46).
- **0003.12** Currency shown as `$` in confirm buttons even after correction acknowledged in text (Olga turn 8).

Each numbered item gets its own `bug-reports/0003.N-...` if/when fixed.
