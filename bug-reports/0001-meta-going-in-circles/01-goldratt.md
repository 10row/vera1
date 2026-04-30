# 0001 — Meta-bug: "we keep going in circles"

User-reported symptom: every other turn the user has to re-explain the same
class of bug, manually verify in production, and watch me ship a new
patch that creates the next symptom. They've named this explicitly:
"this conversation is the example of why we need this."

Goldratt thinking process applied to the META problem so the fix
specification is provable rather than vibes.

---

## Q1 — What MUST be true for this symptom to occur?

For the user-keeps-having-to-explain-and-test pattern to repeat, ALL of:

1. I propose fixes without first reproducing the bug locally with the
   user's exact phrasing/conditions.
2. I have no fast tool that runs the actual production pipeline (real
   AI, real pipeline, real bot) against arbitrary user text.
3. Even when I run a unit/scenario test, the test does not exercise
   adversarial paraphrases of the same intent.
4. The user is the only adversarial tester. They send → bot → fail →
   they explain to me → I patch → they test again.
5. There is no enforced gate preventing me from claiming "fixed" without
   evidence.

If ANY one of those is false, the loop breaks. Specifically: if (4) is
false (i.e. I can adversarially test without bothering them), the user
stops being the QA loop and the circles stop.

## Q2 — Why does each precondition hold?

| Precondition | Cause |
|---|---|
| (1) No repro before fix | No tool that maps a free-text symptom to a deterministic reproducer in <10s. |
| (2) No production-fidelity tool | The harness exists but only runs scripted scenarios; it doesn't accept a one-shot symptom. |
| (3) No paraphrase coverage | Scenarios have hardcoded text; no auto-generation of variants. |
| (4) User is the QA loop | Consequence of (1)+(2)+(3) — the only adversarial input source is them. |
| (5) No enforced gate | Discipline-only; under pressure I skip steps. |

## Q3 — Is there a single root that explains MULTIPLE symptoms?

YES. The constraint is: **there is no required, fast, adversarial
reproduce-and-paraphrase loop that runs against the actual production
pipeline before a fix is declared shipped.**

That single root explains every recent symptom:

| Symptom | How the root explains it |
|---|---|
| Income dropped from brain-dump | Never tested "I get paid X / rent Y / save Z" through real AI before shipping. |
| Russian onboarding broken | Never ran a Russian-language paraphrase through the real onboarding parser. |
| Mini App returned wrong shape | Never tested the actual Mini App fetch contract — assumed shape from memory. |
| Multi-intent loss | Never tested >1 intent in one message against the real AI before claiming v5 was AAA. |
| "Setting up your account" loop | Never adversarially paraphrased to surface the AI's misclassification. |

One root. Five symptoms. That's the Goldratt sign that I'm at the actual
constraint, not a downstream symptom of it.

## Q4 — What assumption forces the conflict?

The assumption is: **"adversarial testing takes longer than asking the
user."**

That assumption is FALSE for any moderately-built tool. A variant
explosion tool runs 10 paraphrases in ~30s with real AI. The user
round-trip ("send me a voice note → it failed → here's what happened →
let me try the fix → it failed again") averages 5–15 minutes per cycle
and burns trust.

Inverting the assumption: testing is FASTER than the user round-trip
once the tool exists. Which means there is no actual conflict; there's
only the missing tool.

## Q5 — Negative branch reservation: what could the fix create?

| Risk | Mitigation |
|---|---|
| Variant tool gives false confidence (10/10 on clean variants but a real-world phrasing still breaks) | Make variants come from a list seeded by REAL user reports — paraphrase those, don't generate from thin air. Each new bug adds a variant template. |
| Pre-commit hook breaks unrelated edits | Project-scoped hook (`.husky/pre-commit` in repo, not global). Bypassable with `--no-verify` for emergencies, with a warning logged. |
| CLAUDE.md becomes wallpaper at >200 lines | Hard-cap CLAUDE.md at 150 lines. Reference detail files, don't inline them. |
| Repro tool produces no-op when it can't parse the symptom | Always emit a transcript and a diagnostic line ("AI returned X intents, expected Y"). Never silent success. |
| "Adversarial agent" is the same model as me, not a real second opinion | OK trade-off. The variant text is the adversarial part, not the agent. We don't need a second model. |

## Build specification (derived from the analysis above)

1. `server/v5/harness/repro.js`
   - CLI: `node server/v5/harness/repro.js "<user symptom text>"`
   - Spawns isolated state (snapshot file optional)
   - Runs real AI + pipeline + bot through a mock chat
   - Outputs: HTML transcript, AI's raw JSON, list of intents emitted
   - Writes `bug-reports/<next-id>/02-repro-output.json`

2. `server/v5/harness/variants.js`
   - CLI: `node server/v5/harness/variants.js bug-reports/<id>`
   - Loads the original symptom text + `expected.intents[]`
   - LLM-paraphrases into 10 variants (different verbosity, ordering,
     language for ru-tagged scenarios, typos)
   - Runs each through the same harness as repro
   - Reports pass/fail per variant — pass means the AI emitted the
     expected intent set
   - Writes `bug-reports/<id>/03-variants.log`

3. Scenario contract update
   - Each scenario gets `expected: { intents: ["add_bill", "record_income", ...] }`
   - Variant runner asserts the produced intent kinds match this set

4. `./CLAUDE.md` — project-only, ≤150 lines
   - Bug-report protocol (the 5 Goldratt questions)
   - Required artifacts after a fix
   - Project commands index (where to find what)

5. `.husky/pre-commit` — project-scoped
   - If any file in `server/v5/{ai,pipeline,bot,validator,model}.js` is
     modified AND no new `bug-reports/<id>/` directory exists from the
     last 24h, warn loudly. Bypass with `--no-verify`.

6. `/debug` Telegram command
   - Returns the AI's raw JSON output for the last user message
   - Production dev tool — no need to ask user to retest

7. Self-proof
   - Run variants tool on existing bugs (income, Russian, brain-dump)
     before any new fix → baseline numbers
   - Apply protocol cold to Russian onboarding → fix → re-run variants
   - Report before/after numbers
   - If post-protocol pass rate isn't measurably better, the system is
     theatre and we revisit.

## Win condition

After this is built, the next 3 bugs you report get reproduced +
adversarially varied + fixed without me asking you to retest in
Telegram. If you still find yourself testing my fixes, the protocol
failed and we redesign.
