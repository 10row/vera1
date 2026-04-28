# v4 — Safe Core

A clean rebuild of the SpendYes engine. Lives alongside v3 so live users keep working.

## Why v4 exists

v3 fused three responsibilities into one path: the LLM proposed structural decisions, the engine applied them silently, and the view sometimes lied about negative numbers. This produced bugs like a $5,000 starting balance being recorded as a $5,000 expense, and "$-700/day" showing as a daily pace.

v4 separates concerns hard. The trust boundary between AI and database is the **validator**.

## Layers

| Layer | File | Job | Trust |
|---|---|---|---|
| **Model** | `model.js` | Domain types, money/date helpers, fresh state | Pure, no I/O |
| **Engine** | `engine.js` | `applyIntent(state, intent) → {state, event}` | Pure. Throws on malformed input |
| **Validator** | `validator.js` | `validateIntent(state, intent) → verdict` | Pure deterministic rules. Decides reject / confirm / auto |
| **View** | `view.js` | `compute(state) → display` | Pure derivation. Never lies about negatives |
| **Tests** | `tests/` | Engine, validator, view, property tests | `node tests/run.js` |

## Flow (once AI/bot are wired)

```
user message
   → AI parser (talk vs do, extracts Intents)
   → validateBatch(state, intents)
       ├─ reject  → tell user, do nothing
       ├─ confirm → show inline keyboard, apply on Yes
       └─ auto    → apply now, show Undo for 30s
   → applyIntent(state, intent) → new state + event
   → compute(state) → display
```

## Invariants enforced

1. `balance = sum(setup) + sum(income) − sum(spend|refund) − sum(bill_payment) + sum(correction_delta)` — engine math is provable.
2. `envelope.spentCents >= 0` always.
3. `view.dailyPaceCents >= 0` always — no "$-700/day" lies.
4. `view.obligatedCents + view.disposableCents === state.balanceCents`.
5. Bill due dates outside `[today−14d, today+730d]` are rejected.
6. Setup with non-positive balance is rejected.
7. Spend > current balance triggers high-friction confirm with explicit warning.
8. Batch > 3 intents per turn is rejected ("one at a time").

The property test (`tests/property.test.js`) verifies all of the above hold across 15,000 randomized intent sequences. If any rule ever breaks, the failing sequence is printed.

## Running tests

```
node server/v4/tests/run.js
```

## What's next (not yet built)

- `ai.js` — talk/do mode parser. Talk mode = pure conversation, never mutates. Do mode = emits Intents that go through the validator.
- `bot.js` — Telegram wiring. Handles the confirmation card flow.
- `server.js` — Express + Prisma adapter. Stores state and event log.
- Mini App rewire to read v4 view.

## Migration plan

v3 keeps running. v4 is built and tested in isolation. Once AI + bot are wired, we either:
- run v4 alongside v3 with a flag, or
- migrate users by replaying their v3 transaction log into v4 intents.

Either way, v3 stays untouched until v4 has been used safely in production.
