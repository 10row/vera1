# Vera / SpendYes — Working Protocol

**This file is read by Claude Code at session start. It is binding.**

You are working on a Telegram money bot. The user cannot inspect your
internal reasoning; they can only inspect the production bot. **Every
shipped fix must be defensible without their help.** This protocol
exists to make that possible.

---

## Bug-report protocol — non-negotiable

When the user reports a symptom (or you suspect one), do these in order.
**Skipping a step is a protocol violation. Document it if forced to skip.**

### 1. Reproduce locally first
```
node server/v5/harness/repro.js [--setup] [--balance=N] [--lang=en|ru] "<symptom text>"
```
- Captures: AI raw output, emitted intents, final state, transcript HTML.
- Writes artifacts to `bug-reports/_tmp/` by default.
- **If you cannot reproduce, you cannot fix.** Get more info from the
  user. Do not patch from a guess.

### 2. Goldratt root-cause analysis (in writing)
Before proposing a fix, answer these in
`bug-reports/<id>/01-goldratt.md`:

1. **What MUST be true for this symptom to occur?** — list the
   preconditions. If you can't list them, you don't understand the bug.
2. **Why does each precondition hold?** — trace each through the layer
   it lives in (data model / validator / AI / pipeline / bot).
3. **Is there a single root that explains MULTIPLE symptoms?** — yes
   means you've hit the constraint. No means you're still on a
   downstream symptom.
4. **What assumption is forcing the conflict?** — name the assumption.
   Is it actually true? (Often it isn't.)
5. **Negative branch — what could the proposed fix break?** — name 1+
   risk and the mitigation.

**Stop rule:** If the proposed fix doesn't also explain at least one
*other* observed symptom, you may not be at the root. Re-run Q3.

### 3. Variant explosion before shipping
```
node server/v5/harness/variants.js bug-reports/<id>
```
- Generates 10 paraphrases, runs each through the full pipeline.
- Pass rate must be ≥ 8/10 before you ship. Lower means the fix is
  brittle or you're at the wrong root.
- If a variant SHOULD fail (genuinely ambiguous input), document it
  in `bug-reports/<id>/expected.json` with a note.

### 4. Add a regression scenario
- Add a permanent scenario in `server/v5/harness/scenarios/` that
  reproduces the exact failure with `expected.intents[]` set.
- Run `node server/v5/harness/run-all.js <name>` and confirm green.

### 5. Only then ship
- Commit message references `bug-reports/<id>/`.
- Push. Tell the user:
  - what the root was (1 sentence)
  - what variant pass rate you hit (e.g. "10/10")
  - the new regression scenario name

**Never ask the user to test in production unless every step above is
green.** The protocol exists so the user is not your QA loop.

---

## Required artifacts per bug

Each bug gets a directory `bug-reports/<id>/` containing:

| File | What | Required |
|---|---|---|
| `01-goldratt.md` | Root-cause answers | YES |
| `02-repro-output.json` | Reproducer artifact | YES |
| `02-repro-transcript.html` | Visual transcript | YES |
| `03-variants.log` | Pass/fail per variant | YES |
| `expected.json` | Optional intent expectations | optional |

A commit that touches `server/v5/{ai,pipeline,bot,validator,model,view}.js`
without a matching `bug-reports/<id>/` from the last 24h is suspect.

---

## Project commands index

| Goal | Command |
|---|---|
| Run all unit tests | `node server/v5/tests/run.js` |
| Run all scenarios (LLM judge) | `node server/v5/harness/run-all.js` |
| Run scenarios skipping LLM | `node server/v5/harness/run-all.js --skip-llm` |
| Reproduce a bug | `node server/v5/harness/repro.js [opts] "<text>"` |
| Variant-test a bug | `node server/v5/harness/variants.js bug-reports/<id>` |
| 10-day simulation | `node server/v5/harness/long-sim.js --days=10 --checkpoint=3` |
| 100-day simulation | `node server/v5/harness/long-sim.js --days=100 --checkpoint=10` |

---

## Vera-specific edges to remember

- **Onboarding is deterministic, not AI.** `server/v5/onboarding.js`
  parses balance + payday with English-centric regexes. Russian users
  hit this; Russian phrasings need explicit support.
- **v5 intents are sparse.** Only: `setup_account`, `adjust_balance`,
  `add_bill`, `remove_bill`, `record_spend`, `record_income`,
  `update_payday`, `undo_last`, `reset`. No `add_envelope`,
  `add_budget`, `add_goal`. Brain-dumps that mention "save X for Y" or
  "$X budget for category" have nowhere to land — that's the income/
  budget data-model gap.
- **Mini App reads `d.view`, `d.recentTransactions`, `d.heatmap`** —
  not `d.pic`. The translation layer is in
  `server/v5/index.js` `v5ToV4View()`.
- **Brain-dump capture re-routes the message** post-onboarding through
  `processText` (outside the lock — re-entering would deadlock).
- **`do_batch` shows ONE combined card** with a single Yes-all button
  rather than v4's "Step N of M" wizard.
- **`/debug` returns the AI's raw last response** — use it to debug
  production without bothering the user.

---

## Things you've gotten wrong before (do not repeat)

- Patching prompt without reproducing — every "AI just needs better
  rules" patch has been undone within 24h. Reproduce first.
- Treating the data model as the prompt's problem — when AI has
  nowhere to put a fact, no prompt fix saves you. Add the field.
- Shipping before variant explosion — you've shipped at "looks green
  in unit tests" four times. The unit tests are not the user.
- Asking the user to retest — every time you say "try it now," you
  have failed the protocol. The variant tool tries it for you.

---

This protocol replaces "I think this fix should work." If you find
yourself believing a fix without artifacts, stop and run the protocol.
The 30 seconds of variant runs has saved hours of user back-and-forth
in this codebase.
