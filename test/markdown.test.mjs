import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown.ts";

function renderedDocument(source) {
  const rendered = renderMarkdown(source);
  const document = JSDOM.fragment(rendered.html);
  assert.equal(document.textContent, rendered.text, "HTML and quote-validation text must match");
  return { ...rendered, document };
}

test("Markdown renders headings, emphasis, lists, quotes, links, code and tables", () => {
  const { document, text } = renderedDocument([
    "# Heading", "", "A **bold** and *italic* ~~deleted~~ paragraph with `code`.", "",
    "> quoted", "", "3. first", "4. second", "", "- [x] done", "- [ ] pending", "",
    "[Read docs](https://example.com/?x=1&amp;y=2)", "",
    "```js", "const x = '<tag>';", "```", "",
    "| Name | Value |", "| --- | --- |", "| one | two |",
  ].join("\n"));
  for (const tag of ["h1", "strong", "em", "del", "blockquote", "ol", "ul", "a", "pre code", "table th", "table td"]) {
    assert.ok(document.querySelector(tag), `Expected ${tag}`);
  }
  assert.equal(document.querySelector("ol").getAttribute("start"), "3");
  assert.equal(document.querySelector("a").href, "https://example.com/?x=1&y=2");
  assert.equal(document.querySelector("a").rel, "noopener noreferrer");
  assert.match(text, /A bold and italic deleted paragraph with code/);
  assert.match(text, /☑ done/);
  assert.match(text, /☐ pending/);
  assert.match(text, /const x = '<tag>';/);
  assert.equal(document.querySelector("input"), null);
});

test("canonical text matches DOM text for entities, breaks, nested blocks and Unicode", () => {
  for (const source of [
    "**Fish &amp; chips** &lt;safe&gt; &#x1f98a; &copy;",
    "line  \nnext\nsoft break\n\nNew paragraph",
    "> **Bold** quote\n>\n> - nested\n> - list",
    "- item\n\n  paragraph\n\n  ```\n  <code> &amp;\n  ```",
    "| **A** | B |\n|---|---|\n| 🦊 | &amp; |",
    "`&amp;` and \\*literal\\* with café and 中文",
    "# heading\r\n\r\nA\0B",
    "<img src=x onerror=alert(1)>\n<script>alert('bad')</script>",
  ]) renderedDocument(source);
  assert.match(renderMarkdown("Fish &amp; chips &copy;").text, /Fish & chips ©/);
  assert.match(renderMarkdown("first  \nsecond").text, /first\nsecond/);
});

test("raw HTML and code stay inert; images never become resources", () => {
  const { document, text } = renderedDocument([
    '<script src="https://evil.example/script.js">alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)><a href="javascript:alert(1)">x</a></svg>',
    '<style>body { background: url(https://evil.example/leak); }</style>',
    "", "![**secret**](https://evil.example/tracker.png)", "",
    '```html', '<img src=x onerror=alert(1)>', '```',
  ].join("\n"));
  assert.equal(document.querySelector("script, iframe, img, svg, style, object, embed, form"), null);
  assert.match(text, /\[Image omitted: secret\]/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  for (const element of document.querySelectorAll("*")) {
    for (const attr of element.attributes) assert.doesNotMatch(attr.name, /^on|^src|^style$/i);
  }
});

test("only explicit HTTP(S) links are clickable, including entity-obfuscated schemes", () => {
  for (const destination of [
    "javascript:alert%281%29", "jav&#x61;script:alert%281%29", "java&#10;script:alert%281%29",
    "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd", "mailto:a@example.com",
    "/api/annotations", "//evil.example/", "#fragment",
  ]) {
    const { document, text } = renderedDocument(`[label](${destination})`);
    assert.equal(document.querySelector("a"), null, destination);
    assert.match(text, /label/);
  }
  const { document } = renderedDocument('[safe](https://example.com/ "ignored title")');
  assert.equal(document.querySelector("a").target, "_blank");
  assert.equal(document.querySelector("a").getAttribute("href"), "https://example.com/");
});
