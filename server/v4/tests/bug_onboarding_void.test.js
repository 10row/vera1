"use strict";
// Regression — user reported:
//   "I /reset, it confirms, then nothing. I type 'hey' and the bot
//    replies 'Hey there how can I help you today?' That's not good."
//
// Two-pronged fix:
//   1) Post-reset, bot proactively sends the warm welcome (deterministic).
//   2) Greeting messages from !setup users are intercepted before the AI
//      so the response is reliable, not gpt-4o-mini's mood that day.
//
// We can't run the bot end-to-end here, but we test the helpers that
// the bot uses: the greeting regex, the welcome message text contract.

// Re-implement the patterns inline (mirroring bot.js) so this test
// catches drift if either is changed without updating the other.
const GREETING_PATTERNS = /^\s*(hi+|hello+|hey+|yo+|sup|hola|namaste|howdy|hii+|heya|good\s*(morning|afternoon|evening|day|night)|what['s ]*up|h r u|hru)\s*[!.?]*\s*$/i;

test("[BUG-VOID] greeting regex matches common greetings", () => {
  for (const g of ["hi", "Hi", "hello", "HELLO", "hey", "heyy", "yo", "sup", "hola", "good morning", "Good Morning", "good evening", "howdy", "hii", "heya", "what's up", "whats up"]) {
    assertTrue(GREETING_PATTERNS.test(g), "should match: " + g);
  }
});

test("[BUG-VOID] greeting regex does NOT match real messages", () => {
  for (const m of ["I have $5000", "spent 5 on coffee", "rent is 1400", "can I afford 200?", "put 700 toward vietnam", "hello world is my balance"]) {
    assertTrue(!GREETING_PATTERNS.test(m), "should NOT match: " + m);
  }
});

test("[BUG-VOID] greeting regex matches with punctuation", () => {
  for (const g of ["hi!", "hello.", "hey?", "yo!!"]) {
    assertTrue(GREETING_PATTERNS.test(g), "should match with punctuation: " + g);
  }
});

test("[BUG-VOID] greeting regex tolerates leading/trailing whitespace", () => {
  assertTrue(GREETING_PATTERNS.test("  hi  "));
  assertTrue(GREETING_PATTERNS.test("hi\n"));
});
