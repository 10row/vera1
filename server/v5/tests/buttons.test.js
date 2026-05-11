"use strict";
// Per-intent button-label tests.
//
// Pre-fix: every confirm card showed generic "Yes" / "Cancel". After the
// user reported the buttons-on-questions bug, we shipped per-intent
// labels — "Reserve" on set-asides, "Add bill" on recurring, "Log it" on
// spends, "Update" on balance corrections. The verb signals what'll
// happen on tap, removing the "Yes means what?" ambiguity.
//
// These tests lock the routing so a future refactor can't accidentally
// regress to "Yes" everywhere.

const { buttonLabelsFor } = require("../bot");

// ── ENGLISH ────────────────────────────────────────────────────
test("[buttons] add_bill 'once' → 'Reserve'", () => {
  const { yes } = buttonLabelsFor({ kind: "add_bill", params: { recurrence: "once" } }, "en");
  assertEq(yes, "Reserve");
});
test("[buttons] add_bill no recurrence → defaults to 'Reserve' (set-aside)", () => {
  const { yes } = buttonLabelsFor({ kind: "add_bill", params: {} }, "en");
  assertEq(yes, "Reserve");
});
test("[buttons] add_bill 'monthly' → 'Add bill'", () => {
  const { yes } = buttonLabelsFor({ kind: "add_bill", params: { recurrence: "monthly" } }, "en");
  assertEq(yes, "Add bill");
});
test("[buttons] add_bill 'weekly' → 'Add bill'", () => {
  const { yes } = buttonLabelsFor({ kind: "add_bill", params: { recurrence: "weekly" } }, "en");
  assertEq(yes, "Add bill");
});
test("[buttons] add_bill 'biweekly' → 'Add bill'", () => {
  const { yes } = buttonLabelsFor({ kind: "add_bill", params: { recurrence: "biweekly" } }, "en");
  assertEq(yes, "Add bill");
});

test("[buttons] record_spend → 'Log it'", () => {
  const { yes } = buttonLabelsFor({ kind: "record_spend", params: { amountCents: 2500 } }, "en");
  assertEq(yes, "Log it");
});
test("[buttons] record_income → 'Log income'", () => {
  const { yes } = buttonLabelsFor({ kind: "record_income", params: { amountCents: 300000 } }, "en");
  assertEq(yes, "Log income");
});
test("[buttons] adjust_balance → 'Update'", () => {
  const { yes } = buttonLabelsFor({ kind: "adjust_balance", params: { newBalanceCents: 500000 } }, "en");
  assertEq(yes, "Update");
});
test("[buttons] update_payday → 'Update payday'", () => {
  const { yes } = buttonLabelsFor({ kind: "update_payday", params: { payday: "2025-05-15" } }, "en");
  assertEq(yes, "Update payday");
});
test("[buttons] remove_bill → 'Remove'", () => {
  const { yes } = buttonLabelsFor({ kind: "remove_bill", params: { name: "Rent" } }, "en");
  assertEq(yes, "Remove");
});
test("[buttons] undo_last → 'Undo'", () => {
  const { yes } = buttonLabelsFor({ kind: "undo_last", params: {} }, "en");
  assertEq(yes, "Undo");
});
test("[buttons] delete_transaction → 'Delete'", () => {
  const { yes } = buttonLabelsFor({ kind: "delete_transaction", params: { id: "tx_abc" } }, "en");
  assertEq(yes, "Delete");
});
test("[buttons] reset → 'Reset everything'", () => {
  const { yes } = buttonLabelsFor({ kind: "reset", params: {} }, "en");
  assertEq(yes, "Reset everything");
});
test("[buttons] unknown kind → 'Confirm' (safe default)", () => {
  const { yes } = buttonLabelsFor({ kind: "transfer_to_attacker", params: {} }, "en");
  assertEq(yes, "Confirm");
});
test("[buttons] no intent at all → 'Confirm'", () => {
  const { yes } = buttonLabelsFor(null, "en");
  assertEq(yes, "Confirm");
});

test("[buttons] cancel label is 'Cancel' across all kinds", () => {
  const kinds = ["add_bill", "record_spend", "record_income", "adjust_balance", "remove_bill", "undo_last", "delete_transaction", "reset"];
  for (const kind of kinds) {
    const { no } = buttonLabelsFor({ kind, params: {} }, "en");
    assertEq(no, "Cancel", "kind " + kind + " should yield Cancel");
  }
});

// ── RUSSIAN ────────────────────────────────────────────────────
test("[buttons-ru] add_bill 'once' → 'Отложить'", () => {
  const { yes, no } = buttonLabelsFor({ kind: "add_bill", params: { recurrence: "once" } }, "ru");
  assertEq(yes, "Отложить");
  assertEq(no, "Отмена");
});
test("[buttons-ru] add_bill 'monthly' → 'Добавить'", () => {
  const { yes } = buttonLabelsFor({ kind: "add_bill", params: { recurrence: "monthly" } }, "ru");
  assertEq(yes, "Добавить");
});
test("[buttons-ru] record_spend → 'Записать'", () => {
  const { yes } = buttonLabelsFor({ kind: "record_spend", params: {} }, "ru");
  assertEq(yes, "Записать");
});
test("[buttons-ru] adjust_balance → 'Обновить'", () => {
  const { yes } = buttonLabelsFor({ kind: "adjust_balance", params: {} }, "ru");
  assertEq(yes, "Обновить");
});
test("[buttons-ru] undo_last → 'Отменить'", () => {
  const { yes } = buttonLabelsFor({ kind: "undo_last", params: {} }, "ru");
  assertEq(yes, "Отменить");
});
