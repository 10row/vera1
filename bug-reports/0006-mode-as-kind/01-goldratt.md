# 0006 — AI returns `{mode: KIND}` instead of `{mode: "do", intent: {kind: KIND}}`

## Symptom (verbatim from user)

> "i said i just got a coffee and breakfast at plantiful 760thb - and
> it responded; hmm didnt catch that. try again - eg.g spent 25 on
> fcoffee or delete the cat --- which also doenst make sense lol."

A legit `record_spend` in foreign currency (THB) fell through to the
fallback talk-mode message ("Hmm, didn't catch that…"). The fallback
also referenced "delete the cat" — placeholder copy that's bizarre.

## Reproduction (`02-repro-output.json`)

`node server/v5/harness/repro.js --setup --balance=50000 --lang=en "i just got a coffee and breakfast at plantiful 760thb"`

**Second run output (the failing one)**:

```json
{ "mode":"record_spend",
  "params":{
    "amountCents":0,
    "originalAmount":760,
    "originalCurrency":"THB",
    "note":"coffee and breakfast at Plantiful",
    "category":"food",
    "vendor":"Plantiful"
  }
}
```

Note: `mode` is `"record_spend"`. The AI collapsed the intent kind
into the `mode` field, dropping the `{mode:"do", intent:{kind:..., params:...}}`
envelope.

The parser at `ai.js:807` only checks `parsed.mode === "do"`. This
doesn't match, doesn't match `"talk"` or `"ask_simulate"` either,
falls through to the talk fallback at line 848. User sees "Hmm,
didn't catch that. Try again — e.g. \"spent 25 on coffee\" or
\"delete the cat\"."

The first run (sanity check) produced the correct shape
`{mode:"do", intent:{kind:"record_spend", params:{...}}}` and worked.
gpt-4o-mini is non-deterministic about which shape it emits — this
is exactly the kind of "usually works" failure that's NOT AAA.

## Technical layer

### Q1. Preconditions — what MUST be true for this to occur?

1. The AI emits JSON where `mode` is one of the INTENT_KINDS (e.g.
   `"record_spend"`, `"add_bill"`, `"adjust_balance"`) instead of
   one of the canonical envelope values (`"do"` / `"talk"` /
   `"ask_simulate"`).
2. The parser in `parseProposal` only handles three canonical
   envelope values and falls through to the talk fallback on
   anything else.
3. No defensive coercion exists for the "AI put intent.kind into
   mode" shape — sibling to the existing defensive coercion for
   "AI dropped the params wrapper" (`normalizeIntent`, ai.js:685).

### Q2. Why does each hold?

1. **AI flub.** gpt-4o-mini is a small model. With foreign-currency
   inputs the params block balloons (originalAmount, originalCurrency,
   note, category, vendor) and the model occasionally compresses the
   envelope. Same root pattern as the dropped-params-wrapper bug
   we already fixed defensively.
2. **Strict parser.** The parser is exhaustive on the three envelope
   shapes but has no "else, try harder" branch beyond the talk
   fallback. By design — we don't want to guess. But for a flub
   that's syntactically obvious (mode value is a valid intent kind),
   we can coerce confidently.
3. **History.** `normalizeIntent` was added when the AI dropped the
   `params:` wrapper. The mode-as-kind flub is the same family of
   error but at a different level of the envelope — and we never
   added a sibling defense.

### Q3. Single root → multiple symptoms?

YES. This explains:
- The reported "didn't catch that" on legitimate record_spend.
- Variants involving foreign currency are MORE likely to trigger
  it (larger params block, more state to compress around).
- Could plausibly affect any intent kind: add_bill, record_income,
  adjust_balance, etc. — not just record_spend.
- It's the same shape family as the previously-fixed missing-params
  bug. We're treating that family one flub at a time instead of
  hardening the whole envelope.

## Goal layer

### Q3.5. What was the user TRYING to do?

LOG A SPEND. Simple. They told the bot they just spent 760 THB on
coffee + breakfast at a place called Plantiful. They want it on
the ledger so today's-left updates.

The user goal is the bot's CORE happy path. If this breaks, the
whole product breaks. There's no "other interpretation" of what
they wanted — they were explicit.

### Q3.6. Does the candidate fix serve the goal?

Yes. Coercing `{mode:KIND, params:{...}}` → `{mode:"do", intent:{kind:KIND, params:{...}}}`
sends the user's spend through the same validation and confirm-card
path as a correctly-shaped intent. They tap [Log it], it lands.

### Q3.7. Multiple goals — which is most common AND most damaging?

There's only one goal here (log a spend). Failing it is maximally
damaging because record_spend is the most-used intent in the bot.
Every failed log = user manually re-typing, or worse, giving up.

## Closeout

### Q4. What assumption is forcing the conflict?

That the AI will reliably follow the strict envelope shape every
time. It doesn't. This is a model-capability gap and we should
treat it as such — defend at the parser layer, don't keep relying
on prompt hardening alone (we've added shape rules to the prompt
twice already and the flub still happens).

### Q5. Negative branch — what could the fix break?

**Risk A: Coercing `mode:"setup_account"` on an already-setup user.**
  - Mitigation: validator rejects `setup_account` post-setup
    anyway. Coercion → validator catches → user sees normalized
    error. No worse than today.

**Risk B: Coercing a typo / non-intent value (e.g. `mode:"recordspend"`).**
  - Mitigation: only coerce when `parsed.mode` is a member of the
    `INTENT_KINDS` allow-list. Otherwise fall through to talk
    fallback as today.

**Risk C: Coercing when the AI ALSO included `parsed.intent` or
`parsed.intents` (conflict).**
  - Mitigation: if those fields are present, prefer them and ignore
    the mode-as-kind flub. Belt + suspenders.

**Risk D: Hiding a deeper AI issue by silently fixing the shape.**
  - Mitigation: log a warning when coercion fires so /debug surfaces
    it. Visible in production, doesn't hide from us.

## Fix plan

1. **ai.js parseProposal**: before the `parsed.mode === "do"` check,
   add a coercion: if `parsed.mode` is in INTENT_KINDS and there's
   no `parsed.intent` / `parsed.intents`, rewrite to canonical
   shape and proceed as `mode:"do"`. Log a warning.
2. **ai.js system prompt**: add explicit "mode is ONE OF {do, talk,
   ask_simulate, ask_clarify} — never an intent kind" rule near the
   top.
3. **ai.js fallback copy**: replace "delete the cat" with sensible
   examples ("undo last" / "what's available today").
4. **Tests**: lock the coercion behavior — parser tests for the
   mode-as-kind shape across record_spend, add_bill, adjust_balance,
   record_income. Negative test for non-intent mode value.
5. **Regression scenario**: add `server/v5/harness/scenarios/foreign-spend-mode-flub.js`
   that uses a mocked AI to return the bad shape, and asserts the
   pipeline still emits a record_spend.
6. **Variant test**: run 10 paraphrases of the original symptom
   against the live AI (foreign-currency spends).

## Stop-rule check

- Single root explains > 1 symptom? **Yes** — any intent kind can
  trigger this, not just record_spend.
- Negative-branch identified + mitigated? **Yes** — see Q5.
- Goal sentence clear? **Yes** — "log a spend".

Ship after variants ≥ 8/10.
