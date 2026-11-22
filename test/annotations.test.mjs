import test from "node:test";
import assert from "node:assert/strict";
import { validateAnnotations, formatAnnotations } from "../src/annotations.ts";

test("validation binds each quote to exact offsets, including Unicode", () => {
  const text = "A 🦊 reactor module";
  const item = { start: 5, end: 12, quote: "reactor", comment: " Explain this. " };
  assert.equal(validateAnnotations([item], text)[0].comment, "Explain this.");
  for (const invalid of [[], Array(51).fill(item), [{ ...item, start: -1 }], [{ ...item, quote: "other" }], [{ ...item, comment: " " }], [{ ...item, end: 999 }], [{ ...item, comment: "a".repeat(8001) }]]) {
    assert.throws(() => validateAnnotations(invalid, text));
  }
});

test("formatted annotations quote every line", () => {
  const text = formatAnnotations("abc", [{ quote: "first\nsecond", comment: "Why?" }]);
  assert.match(text, /response abc/);
  assert.match(text, /> first\n> second\n\nWhy\?/);
});
