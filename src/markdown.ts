import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import { Marked, Renderer } from "marked";
import { parseFragment } from "parse5";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerAliases("shell", { languageName: "bash" });

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function textContent(node) {
  if (node.nodeName === "#text") return node.value;
  return (node.childNodes ?? []).map(textContent).join("");
}

function safeLink(href) {
  // Markdown destinations may contain entities. Decode them as text, without
  // interpreting tags, before checking the protocol (including obfuscated schemes).
  const decoded = textContent(parseFragment(href.replaceAll("<", "&lt;")));
  try {
    const url = new URL(decoded);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const renderer = new Renderer();
// Raw HTML is visible literal text, never active markup. All other HTML comes
// from Marked's built-in escaping or the restricted renderer methods below.
renderer.html = ({ text }) => escapeHtml(text);
renderer.code = function (token) {
  const language = token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!language || !hljs.getLanguage(language) || token.text.length > 32_000) {
    return Renderer.prototype.code.call(this, token);
  }
  // Match Marked's trailing newline so highlighting never changes quote offsets.
  const code = token.text.replace(/\n$/, "");
  const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
  return `<pre><code class="hljs language-${escapeHtml(language)}">${value}\n</code></pre>\n`;
};
renderer.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  const url = safeLink(href);
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
};
renderer.image = function ({ tokens }) {
  // Preserve a selectable description, but do not create an image or resource URL.
  return `<span class="omitted-image">[Image omitted: ${this.parser.parseInline(tokens)}]</span>`;
};
// A real text newline makes hard breaks part of the same selection text model.
renderer.br = () => "<br>\n";
// Task inputs add no useful text and are not interactive in this view.
renderer.checkbox = ({ checked }) => checked ? "☑ " : "☐ ";

const markdown = new Marked({ renderer, gfm: true, async: false });

export function renderMarkdown(source) {
  const html = markdown.parse(source);
  // Match browser DOM textContent, not Markdown source, innerText, or whitespace
  // guessed by the client. HTML5 parsing handles entities, tables, and Unicode.
  // Range.toString() uses this same text-node ordering across nested formatting.
  return { html, text: textContent(parseFragment(html)) };
}
