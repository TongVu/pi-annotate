import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

async function findLoader() {
  if (process.env.PI_EXTENSION_LOADER) return process.env.PI_EXTENSION_LOADER;
  const root = process.env.PI_MANAGED_INSTALL_ROOT;
  if (!root) return undefined;
  try {
    const version = (await readFile(join(root, "current-version"), "utf8")).trim();
    const path = join(root, "releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

const loaderPath = await findLoader();
test("Pi reload picks up changed local helper modules in the same process", {
  skip: loaderPath ? false : "Set PI_EXTENSION_LOADER to the installed Pi dist/core/extensions/loader.js",
}, async (t) => {
  const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(loaderPath).href);
  const root = fileURLToPath(new URL("../", import.meta.url));
  // Keep the fixture beside node_modules so local production dependencies resolve.
  const directory = await mkdtemp(join(root, ".reload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, "src"), join(directory, "src"), { recursive: true });
  await cp(join(root, "web"), join(directory, "web"), { recursive: true });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const entry = join(directory, "src/index.ts");
  let extension;
  const shutdown = async () => {
    for (const handler of extension?.handlers.get("session_shutdown") ?? []) await handler({}, {});
  };
  t.after(shutdown);

  const run = async () => {
    const loaded = await loadExtensions([entry], directory);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    let link;
    let draft = "Existing draft";
    await extension.commands.get("annotate").handler("link", {
      mode: "tui", isIdle: () => true,
      sessionManager: {
        getSessionId: () => "reload-session",
        getBranch: () => [{ id: "reload-response", type: "message", message: {
          role: "assistant", content: [{ type: "text", text: "**Bold** response" }],
        } }],
      },
      ui: {
        notify: (message) => { if (message.includes("http://127.0.0.1:")) link = message.split(": ").at(-1); },
        getEditorText: () => draft,
        setEditorText: (text) => { draft = text; },
      },
    });
    const url = new URL(link);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    const { response } = await (await fetch(`${url.origin}/api/response`, { headers })).json();
    assert.equal(JSDOM.fragment(response.html).textContent, response.text);
    return { response, url, headers, draft: () => draft };
  };

  const before = await run();
  assert.equal(before.response.text, "Bold response\n");
  await shutdown();
  const helper = join(directory, "src/markdown.ts");
  const source = await readFile(helper, "utf8");
  const needle = "const html = markdown.parse(source);";
  assert.ok(source.includes(needle));
  await writeFile(helper, source.replace(needle, 'const html = markdown.parse(source + "\\n\\nReload marker.");'));
  clearExtensionCache();

  const after = await run();
  assert.match(after.response.text, /Reload marker/);
  const quote = "Reload marker.";
  const start = after.response.text.indexOf(quote);
  const transferred = await fetch(`${after.url.origin}/api/annotations`, {
    method: "POST", headers: after.headers,
    body: JSON.stringify({ annotations: [{ start, end: start + quote.length, quote, comment: "Explain." }] }),
  });
  assert.equal(transferred.status, 200);
  assert.match(after.draft(), /^Existing draft\n\nQuestions about assistant response reload-response:/);
  assert.match(after.draft(), /> Reload marker\./);
});
