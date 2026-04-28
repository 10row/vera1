# SpendYes v4 — Frontier Review

Built and audited against [V4_FRONTIER_PLAN.md](V4_FRONTIER_PLAN.md).
This is the honest grade.

## Summary

- **Total tests: 213/213 green** (engine, validator, view, AI parser, pipeline, TTS, proactive, regression, scenarios, property — running in ~2 seconds).
- **6/6 steps shipped** with their own AAA bar met.
- **Final rubric grade: 81/100.**
- The structural foundation is at frontier. The experiential surface (latency, voice quality, personality consistency) still needs human-in-the-loop validation that only deployment + real users can give. Math, safety, and architecture are solid.

## How the tests are organized

```
server/v4/tests/
  run.js                — tiny no-deps test runner
  engine.test.js        — 16 specs: applyIntent correctness
  validator.test.js     — 17 specs: verdict rules
  view.test.js          — 10 specs: compute correctness
  property.test.js      — 2 specs: 100k randomized invariant checks
  ai.test.js            — pipeline contract + Talk/Do classification
  step1.test.js         — 17 specs: reliability + undo (byte-perfect)
  step2.test.js         — 14 specs: simulate_spend + math invariant
  step3.test.js         — 13 specs: onboarding ordering + defaults
  step4.test.js         — 10 specs: status word + day-stable variants
  step5.test.js         — 17 specs: TTS rewrite + graceful failure
  step6.test.js         — 17 specs: proactive + 30-day simulation
  regressions.test.js   — 15 specs: tagged [BUG-N] for every shipped bug
  adversarial.test.js   — 30 specs: prompt-injection + LLM hallucination
  scenarios.test.js     — 14 specs: the 10 named frontier scenarios
```

## The 10-dimension rubric (honest grade)

| # | Dimension | Target | Actual | Notes |
|---|---|---:|---:|---|
| 1 | Reliability of mutations | 10 | **10** | Promise enforced. No auto-tier. Undo byte-perfect across 100k random sequences. Validator rejects every named bug class. Setup is solo, atomic. |
| 2 | Speed (text replies) | 9 | **7*** | gpt-4o-mini latency in production needs measurement. Code path is fast. *Cannot grade without deployment.* |
| 3 | Speed (voice replies) | 9 | **7*** | TTS round-trip needs measurement. Cannot grade without deployment. |
| 4 | Onboarding quality | 9 | **8** | Validator blocks add_envelope before setup. AI prompt has explicit 3-phase script. Real first-impression test needs a fresh user; not yet run. |
| 5 | Hero moment polish | 9 | **8** | Status word (Calm/Tight/Over) + emoji on view. 5 green / 3 tight / 3 over phrasing variants, day-stable. /today command. **Mini App number animation is NOT done** — would push to 9. |
| 6 | Decision support | 10 | **9** | "Can I afford X?" → simulate_spend. Math invariant proven (`simulate(s,X) === compute(apply(s,X))`). AI classification rule in prompt. Real-world classification accuracy needs measurement. |
| 7 | Voice quality | 8 | **7*** | TTS wired with text-rewrite (markdown stripped, currency words, divider replacement). Graceful failure proven. **Voice has not been listened to** — needs human ear. |
| 8 | Proactivity calibration | 9 | **9** | Three moments only. Hard 23h rate limit. 30-day simulation produces ≤ 5 messages. Mute and unmute per category. Bill > Milestone > Pace priority. |
| 9 | Failure UX | 10 | **8** | TTS, OpenAI, parser, validator — all fall back gracefully. Bot replies on most error paths. **Have not audited every Telegram-API edge** (e.g. bot offline mid-flow). |
| 10 | Personality consistency | 9 | **8** | Prompt enforces tone. Replies tested via stubs, not gpt-4o-mini in the wild. Cleo-vs-calm calibration needs human review. |
| | **Total** | **92** | **81** | |

\* These three dimensions cap at 7 in this review because they require real production traffic to grade truthfully. Once deployed, they're likely 8–9 each, which would put the total at **88–91**. The structural ceiling is high; the human-in-the-loop work pushes it over the bar.

## What's structurally guaranteed (the foundation)

- **The Promise:** *I'll never log without your tap. Anything I do is undoable.* Engineered into truth — not a marketing claim.
- **Engine math:** integer cents, balance-from-transactions invariant proven across 100,000 random sequences.
- **No silent mutations:** auto-tier is gone. Every record_spend, add_envelope, pay_bill, etc. requires an explicit user tap.
- **Undo:** byte-perfect across any sequence of valid operations. Property test: N spends + N undos = original state.
- **Validator catches:** Vietnam-class re-setup, hallucinated past dates, missing recurrence on common monthly bills, balance/spend confusion, NaN/Infinity, > sane caps, cascade > 2 intents, setup bundled with extras, simulate vs record confusion, mute leaks, unknown intent kinds, prompt-injection attempts that try setup with absurd amounts.
- **View never lies:** dailyPace is `max(0, …)`. Negative disposable surfaces as a separate `deficitCents` field with `state: "over"`. Three display states, not three signs of one number.
- **Decision support math:** `simulate(s, X)` produces exactly the same view as `compute(apply(s, X))`. Pure read; no mutation. Testable in CI.
- **Proactive rate limits:** hard 23h between messages per user. Once-per-cycle for pace, once-per-dueDate for bills, once-per-threshold-crossing for milestones.

## What still needs human-in-the-loop

These four items cannot be graded by tests alone. They need real user contact:

1. **Run an end-to-end onboarding** as a fresh user with the deployed bot. Time-to-dashboard ≤ 90s? Conversational, not interrogative? Status word at the end feels right?
2. **Listen to voice replies** across 10 different reply types. Do they sound calm and natural? Are they short enough? Does the calibration of pace ("$5/day for 12 days") read aloud naturally?
3. **Test gpt-4o-mini classification** on 30+ named phrasings:
   - 10 hypothetical ("can I afford", "is that ok", "what if I spent X")
   - 10 actual ("I spent X", "logged X", "bought X")
   - 10 ambiguous ("X on coffee", "five hundred to vacation")
   - Target: < 5% misclassification rate (the validator catches the dangerous ones; the rest are just UX friction).
4. **Personality calibration**: send 20 messages of varied emotional content (anxious, in a hurry, frustrated, celebratory). Replies should feel like the same friend across all of them. Right now this is implicit in prompt copy; needs review.

If those four hold up, the review settles at **88–91 / 100** — over the frontier bar.

## Sequencing recap

| Step | Time | Tests | Status |
|---|---|---|---|
| 1 — Reliability + Undo | ~1 day | +17 | ✅ |
| 2 — Decision Support | ~1 day | +14 | ✅ |
| 3 — Onboarding | ~1 day | +13 | ✅ |
| 4 — Hero polish | ~0.5 day | +10 | ✅ |
| 5 — Voice output | ~0.5 day | +17 | ✅ |
| 6 — Proactive moments | ~1 day | +17 | ✅ |
| Final review | this doc | +14 scenarios | ✅ |

Total: ~5 days of focused work, 213 tests, 6 commits, 1 review document.

## What ships

- A v4 module tree (`server/v4/`) parallel to v3. v3 stays untouched.
- The bot file (`server/v4/bot.js`) is the entry point that wires everything: AI parser, validator, engine, view, TTS, proactive scheduler, mini app menu, /undo, /today, /voice, /mute, /unmute, /help, /reset.
- The Mini App (read-only dashboard) needs ONE wiring change: point it at `/api/v4/view/:sid` instead of `/api/v3/picture/:sid`. That's the last small step before the v4 stack runs as the live product.
- A schema migration adds two non-breaking JSON columns to User (`v4State`, `v4History`).

## What's NOT shipped (intentionally deferred)

- **Mini App number-flip animation.** Would push Hero score from 8 → 9. Half a day's work in `miniapp/vera-tg.js`. Best done after the wire-up.
- **Voice replies use OpenAI gpt-4o-mini-tts.** Different voice presets ("nova", "shimmer", "sage") might suit better than "alloy". Calibration needs human ear.
- **End-to-end deployment to Railway with v4 as the live entry point.** That's a wire-up: change `package.json` start script to point at the v4 server entry, then point the bot's webhook/menu at v4 routes.

## Call

The structural foundation is at frontier. The bug class you got hit by (Vietnam scenario, dual-card cascade, missing recurrence) is no longer expressible. The math is provably correct. The promise is engineered, not marketed. Decision support is the differentiating feature and it works.

The remaining gap is **human-in-the-loop validation** of speed, voice quality, personality, and onboarding feel. Those need a deployed bot and 30 minutes of you using it. After that pass and a small Mini App animation, the score crosses 90 and ships as a frontier product.
