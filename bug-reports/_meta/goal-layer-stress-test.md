# Stress-test: does adding a "Goal Layer" to the protocol change the fix?

The protocol today asks Q1-Q5 (preconditions, why, root, assumption,
negative branch). All technical. Missing: **what was the USER trying to
do?** Same symptom can map to different goals → different right fixes.

Re-analyze 3 past bugs with the Goal Layer added between Q3 (single root)
and Q5 (negative branch). The Goal Layer asks:

  G1. What was the user trying to ACHIEVE when they triggered the symptom?
  G2. Did the fix make that goal easy, or just patch the mechanism?
  G3. If multiple plausible goals, which is most common? Which is most
      damaging when missed?

If the Goal Layer changes the right fix in 2/3 cases, adopt it.

---

## Bug A: "Income dropped from brain-dump"

| Layer | Old answer | With Goal Layer |
|---|---|---|
| Q1 (preconditions) | AI dropped record_income; no income field on state | Same |
| Q3 (root) | v5 has no place to store monthly income as a fact | Same |
| **G1 (goal)** | n/a | "User wants the bot to KNOW their income so it can advise — savings rate, post-bills runway, what they can afford long-term." |
| **G2 (does fix serve goal?)** | n/a | Storing the number isn't enough — the bot must USE it in advice. The fix needs prompt + DNA + hero updates, not just a new field. |
| Q5 (fix) | Add `incomeAmountCents` field | Add field AND wire it into hero/DNA/prompt so advice is meaningfully better |

**Verdict:** Goal Layer changed the fix scope. Storing alone is hollow.

---

## Bug B: "Russian user sees $"

| Layer | Old answer | With Goal Layer |
|---|---|---|
| Q1 | language=ru committed but currency stays USD | Same |
| Q3 (root) | Language commit doesn't carry currency forward | Same |
| **G1 (goal)** | n/a | "User wants to see amounts in their actual currency without thinking about it." |
| **G2** | n/a | Auto-detect from language covers 90%, but what about a US user travelling in Russia, or an emigrant? They need an override. |
| Q5 (fix) | Tie currency to language at commit time | Auto-detect + add `update_settings` mid-session command "switch to USD" (also documented). |

**Verdict:** Goal Layer adds an escape hatch the user-needs-it case demands.
Without it, RU user with USD account would get the wrong default and be
stuck.

---

## Bug C: "Bills silently dropped after confirm"

| Layer | Old answer | With Goal Layer |
|---|---|---|
| Q1 | User tapped Undo button after applying intent → reversed bill | Same |
| Q3 (root) I named first | "Undo button has no context label" | Insufficient. |
| **G1 (goal — multiple)** | n/a | Tapping Undo can mean: (1) dismiss the hero card; (2) anxious/unsure, want a back button; (3) real mistake, want to revert; (4) exploring "what does this button do?" |
| **G2 (does label-fix serve all goals?)** | n/a | Label helps #2/#3 (informed choice). Doesn't help #1 (still tap to dismiss) or #4 (still tap to explore). |
| **G3 (most damaging missed goal?)** | n/a | #1 (dismiss) — most frequent (4/4 personas). User wants hero to "go away," undo nukes their work as a side effect. |
| Q5 (right fix) | Label the button | DECOUPLE: hero has no buttons (informational). Undo lives ONLY on the confirm message (the "✓ done" edit) for ~2 minutes, then disappears. /undo command is the long-tail recourse. |

**Verdict:** Goal Layer changes the fix entirely. My label-the-button
fix would have shipped and kept hitting #1 in production.

---

## Conclusion: adopt the Goal Layer

3/3 bugs analyzed. In bug C the Goal Layer led to a STRUCTURALLY different
(better) fix. In A and B it expanded scope to make the fix actually serve
the user's intent rather than just close the technical gap.

**Adoption: add Goal Layer Q3.5–Q3.7 to the protocol in CLAUDE.md
between Q3 and Q5.**
