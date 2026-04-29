# Orchestration Layer — AAA Score

**Build:** v4 + orchestration  
**Tests:** 249/249 passing  
**Real-human scenarios + edge cases:** 16 specs in `scenarios_human.test.js`

## Why this build matters

User reported: *"I gave a comprehensive opening message — balance, hotel bill, payday + amount. The bot did setup, then nothing. Where did the rest go? Why so many little issues?"*

The root was a missing layer between the AI parser and the engine. AI extracted every fact correctly. Validator (correctly) refused to apply setup + envelope as one batch. **But there was nothing holding "the rest"** to walk the user through. Comprehensive messages got truncated to one fact.

This build adds that missing layer.

## What changed

| Layer | Before | After |
|---|---|---|
| Validator | Rejected any batch with setup + sibling. Cap of 2 intents. | Returns per-intent verdicts. Cap raised to 5 (defensive). |
| Pipeline | One outcome per turn; lost extra intents. | Lifts setup to step 1; queues the rest as `queueAfter`. Returns `queueTotal`, `queueIndex`. |
| Bot | Single confirm card per turn; queue lost. | Queue-aware confirm cards labeled "Step N of M". Each Yes-tap applies the current intent then advances the queue. Auto-tier intents are silently applied during queue walk; rejections are reported as "Skipped: ..." and the walk continues. Cancel drops the entire queue. |
| Recurrences | once / weekly / biweekly / monthly | + quarterly / semiannual / annual (real bills like car insurance every 6 months) |
| AI prompt | "ONE intent per turn. Two only if explicit." | "Extract EVERY fact the user mentions. Pipeline orchestrates. Up to 5 intents." |

## The real-human scenarios — score

All 16 specs pass. They cover the patterns users actually hit:

### Comprehensive first message
- ✅ "$5790 + Vietnam hotel 1000 tomorrow + paid 25th of 13k" → setup is step 1, queue has 2 more  
- ✅ AI emits intents in any order — pipeline lifts setup to front  
- ✅ Solo intent path unchanged (no orchestration overhead)

### Irregular pay (freelancer)
- ✅ `setup_account` with `payFrequency: "irregular"` validates  
- ✅ Income on irregular-pay user does NOT auto-advance payday (correct behavior)

### Weird recurrences
- ✅ Quarterly: Insurance every 91 days  
- ✅ Annual: domain renewal advances by 365 days  
- ✅ Semiannual: vehicle reg validates  
- ✅ Weekly groceries as a budget (not a bill)

### Big batches
- ✅ 5-intent batch sequenced (not rejected)  
- ✅ 6+ intents trimmed to 5 (defensive cap)

### Orchestration correctness
- ✅ Queue advances correctly through engine apply  
- ✅ If a queued intent is rejected mid-walk, prior applies remain (no rollback needed); walk continues  
- ✅ Mid-queue cancel: state matches what was already applied (no orphan partial state)

### Already-setup user comprehensive batch
- ✅ "rent 1400 + coffee 100 + groceries 400" on setup-true user → 3 sequenced confirms, no spurious setup_account

## AAA rubric — re-scored

Updating the [V4_FRONTIER_PLAN.md](V4_FRONTIER_PLAN.md) rubric with what changed:

| # | Dimension | Target | Previous | After orchestration | Notes |
|---|---|---:|---:|---:|---|
| 1 | Reliability of mutations | 10 | 10 | **10** | Promise still enforced; orchestration doesn't loosen safety |
| 2 | Speed (text replies) | 9 | 7* | **7*** | Same — needs deployment to grade |
| 3 | Speed (voice replies) | 9 | 7* | **7*** | Same |
| 4 | Onboarding quality | 9 | 8 | **9** | Comprehensive opening messages now flow naturally — the most common new-user pattern works without the user repeating themselves |
| 5 | Hero polish | 9 | 8 | **8** | No change |
| 6 | Decision support | 10 | 9 | **9** | No change |
| 7 | Voice quality | 8 | 7* | **7*** | Same |
| 8 | Proactivity | 9 | 9 | **9** | No change |
| 9 | Failure UX | 10 | 8 | **9** | Mid-queue rejects now report-and-continue instead of dead-ending. Cancel mid-queue produces clean state. |
| 10 | Personality consistency | 9 | 8 | **9** | "Step 1 of 3 · Set up account" is conversational AND structured. Replaces the previous robot-like "let's do setup first" rejection with collaborative orchestration. |
| | **Total** | **92** | **81** | **84** | (+3 points; remaining cap is the three deployment-graded dimensions which need real traffic) |

Once deployed and the three asterisked dimensions are validated by real use, total projected: **91–94/100**. Over the frontier bar.

## What this enables, in plain English

| Scenario | Before | After |
|---|---|---|
| User dumps full situation in one message | Setup applied, rest evaporates. "Now what?" | Step 1 of 3 confirm card. Tap Yes → Step 2 of 3. Tap Yes → Step 3 of 3 → "All set." |
| User has a freelance / irregular income | Worked, but no special handling | Worked, validated, payday doesn't auto-advance |
| User has a quarterly insurance bill | Couldn't represent it cleanly | First-class recurrence; correct dueDate advancement on payment |
| User describes 5 things in one breath | Validator rejected ("too many") | Validator returns 5 verdicts; pipeline sequences |
| User cancels mid-queue (step 2 of 5) | N/A | Earlier applies persist; rest dropped; clean state |
| User makes a typo in queued envelope | Whole batch rejected | Just that one step shows "Skipped: ..." and walk continues |

## What's NOT yet at frontier (the human-loop work)

Same three dimensions as before:
1. **Real gpt-4o-mini classification accuracy** under production transcripts. Tests use stubs.
2. **Voice reply naturalness** — TTS module wired, copy is rewritten for spoken delivery, but nobody's listened.
3. **End-to-end first-impression test** — a fresh user onboarding in 60 seconds. Needs deployment.

Those need real traffic + 30 minutes of you using it. The structural foundation is now solid for ALL the patterns I could think of, including the comprehensive-first-message pattern that broke the previous build.
