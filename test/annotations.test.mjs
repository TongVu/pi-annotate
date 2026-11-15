import test from "node:test";
import assert from "node:assert/strict";
import { latestAssistantResponse, validateAnnotations, formatAnnotations, appendToDraft } from "../src/annotations.ts";

const message = (id, role, content) => ({ id, type: "message", message: { role, content } });

test("latest response uses current branch text, omitting thinking and tool calls", () => {
  assert.deepEqual(latestAssistantResponse([
    message("a", "assistant", [{ type: "text", text: "Older" }]),
    message("b", "assistant", [{ type: "thinking", thinking: "secret" }, { type: "text", text: "One" }, { type: "text", text: "Two" }]),
    message("c", "assistant", [{ type: "toolCall", name: "bash" }]),
    message("d", "toolResult", "output"),
  ]), { id: "b", text: "One\n\nTwo" });
  assert.equal(latestAssistantResponse([]), undefined);
});

test("validation binds each quote to exact offsets, including Unicode", () => {
  const text = "A 🦊 reactor module";
  const item = { start: 5, end: 12, quote: "reactor", comment: " Explain this. " };
  assert.equal(validateAnnotations([item], text)[0].comment, "Explain this.");
  for (const invalid of [[], Array(51).fill(item), [{ ...item, start: -1 }], [{ ...item, quote: "other" }], [{ ...item, comment: " " }], [{ ...item, end: 999 }], [{ ...item, comment: "a".repeat(8001) }]]) {
    assert.throws(() => validateAnnotations(invalid, text));
  }
});

test("formatted annotations quote every line and preserve the existing draft", () => {
  const text = formatAnnotations("abc", [{ quote: "first\nsecond", comment: "Why?" }]);
  assert.match(text, /response abc/);
  assert.match(text, /> first\n> second\n\nWhy\?/);
  assert.equal(appendToDraft("Existing draft", text), `Existing draft\n\n${text}`);
  assert.equal(appendToDraft("", text), text);
  assert.equal(appendToDraft("Draft\n\n", text), `Draft\n\n${text}`);
});
