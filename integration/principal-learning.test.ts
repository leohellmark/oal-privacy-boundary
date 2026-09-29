import assert from "node:assert/strict";
import { test } from "node:test";
import { consultationPolicy, exactQuoteSpan, preferenceSuggestion, quoteAtSpan, validatesQuotedPreference } from "./principal-learning";

test("an agent can cite only an actual user passage", () => {
  const message = { role: "user", content: "Show me the working app before the strategy memo." };
  assert.equal(validatesQuotedPreference(message, "working app before the strategy memo"), true);
  assert.equal(validatesQuotedPreference(message, "I hate strategy"), false);
  assert.equal(validatesQuotedPreference({ ...message, role: "assistant" }, "working app before the strategy memo"), false);
});

test("a cited span stays exact across Unicode text and stores no second quote", () => {
  const content = "✨ Show me the working app before a long memo.";
  const quote = "Show me the working app";
  const span = exactQuoteSpan(content, quote);
  assert.deepEqual(span, { offset: 2, length: 23 });
  assert.equal(quoteAtSpan(content, span!.offset, span!.length), quote);
  assert.equal(quoteAtSpan(content, -1, 10), null);
});

test("preference suggestions have bounded structured fields", () => {
  assert.equal(preferenceSuggestion.safeParse({
    source_excerpt: "working app before the strategy memo",
    category: "planning", statement: "Prefers to inspect a working app before a strategy memo.",
  }).success, true);
  assert.equal(preferenceSuggestion.safeParse({
    source_excerpt: "felt tired", category: "current_mental_state", statement: "Needs recovery now.",
  }).success, false);
});

test("nothing unconfirmed influences consultation", () => {
  assert.equal(consultationPolicy(false, 12), "disabled");
  assert.equal(consultationPolicy(true, 0), "no_confirmed_preferences");
  assert.equal(consultationPolicy(true, 2), "advisory_only");
});
