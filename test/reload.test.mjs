import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { AUTO_CHAT_SESSION } from "../src/resume-chat.ts";
import { requestOwnedChat } from "../src/session-owner.ts";

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

test("installed Pi accepts a browser prompt before the model finishes, then exposes the reply", {
  skip: !loaderPath && "Requires an installed Pi loader",
  timeout: 10000,
}, async (t) => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(new URL("../../index.js", pathToFileURL(loaderPath)));
  if (!ModelRuntime) return t.skip("Requires Pi's ModelRuntime and faux provider");
  const { fauxProvider, fauxAssistantMessage } = await import(new URL("../../../../pi-ai/dist/index.js", pathToFileURL(loaderPath)));
  if (!fauxProvider) return t.skip("Requires Pi's faux provider");
  const cwd = await mkdtemp(join(tmpdir(), "pi-annotate-chat-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "explorer-agent");
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const faux = fauxProvider({ provider: "annotate-test", models: [{ id: "vision", input: ["text", "image"] }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const adapter = join(cwd, "test-chat-launch.ts");
  const openLog = join(cwd, "browser-url");
  await writeFile(adapter, `
    import { writeFile } from "node:fs/promises";
    import { registerAnnotationExtension } from ${JSON.stringify(extensionPath)};
    export default function (pi) {
      registerAnnotationExtension(pi, (url) => writeFile(${JSON.stringify(openLog)}, url));
    }
  `);
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager,
    additionalExtensionPaths: [adapter],
    extensionFactories: [(pi) => pi.on("input", (event) => event.source === "extension"
      ? { action: "transform", text: `Transformed: ${event.text}` } : undefined)],
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, modelRuntime, model, settingsManager, resourceLoader: loader,
    sessionManager, noTools: true,
  });
  const previousTarget = process.env[AUTO_CHAT_SESSION];
  process.env[AUTO_CHAT_SESSION] = sessionManager.getSessionId();
  t.after(() => {
    if (previousTarget === undefined) delete process.env[AUTO_CHAT_SESSION];
    else process.env[AUTO_CHAT_SESSION] = previousTarget;
  });
  let link;
  let finishReply;
  const replyGate = new Promise((resolve) => { finishReply = resolve; });
  let imagePrompt;
  faux.setResponses([
    async () => {
      await replyGate;
      return fauxAssistantMessage("Here is the **answer**.");
    },
    fauxAssistantMessage("Here is more detail."),
    fauxAssistantMessage("Text file received."),
    (context) => {
      imagePrompt = context.messages.findLast(({ role }) => role === "user");
      return fauxAssistantMessage("Image received.");
    },
  ]);
  const errors = [];
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: {
    notify(message) { if (message.includes("http://127.0.0.1:")) link = message.split(": ").at(-1); },
  } });
  try {
    session.setSessionName("Live browser chat feature");
    assert.ok(link, JSON.stringify(errors));
    let opened;
    for (let attempt = 0; attempt < 30 && opened !== link; attempt++) {
      opened = await readFile(openLog, "utf8").catch(() => undefined);
      if (opened !== link) await delay(10);
    }
    assert.equal(opened, link);
    assert.equal(process.env[AUTO_CHAT_SESSION], undefined);
    assert.equal(faux.state.callCount, 0, "opening the browser never starts a model turn");
    let url = new URL(link);
    const makeHeaders = () => ({ Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" });
    let headers = makeHeaders();
    const state = async (suffix = "") => (await fetch(`${url.origin}/api/response${suffix}`, { headers })).json();
    const send = (body) => fetch(`${url.origin}/api/chat`, {
      method: "POST", headers, signal: AbortSignal.timeout(3000), body: JSON.stringify(body),
    });
    const rename = (name) => fetch(`${url.origin}/api/session/name`, {
      method: "POST", headers, body: JSON.stringify({ name }),
    });
    assert.equal((await send({ requestId: "e126ac9d-7780-4853-8de2-5d6d0a869093", text: "/literal question" })).status, 200, JSON.stringify(errors));
    const working = await state();
    assert.equal(working.busy, true);
    assert.equal(working.sessionName, "Live browser chat feature");
    assert.deepEqual(working.messages.map(({ role, text }) => [role, text]), [["user", "Transformed: /literal question"]]);
    const renamed = await rename("Browser-renamed session");
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { sessionName: "Browser-renamed session" });
    assert.equal((await state()).sessionName, "Browser-renamed session");
    if (process.platform !== "win32") {
      const registry = join(process.env.PI_CODING_AGENT_DIR, "pi-annotate-owners");
      const request = () => requestOwnedChat(registry, sessionManager.getSessionId());
      assert.equal(await request(), "already-open");
      const oldUrl = url.href;
      assert.equal((await fetch(`${url.origin}/api/close`, { method: "POST", headers, body: "{}" })).status, 200);
      assert.equal(await request(), "attached", "the original working process must open a fresh browser tab");
      url = new URL(link);
      headers = makeHeaders();
      assert.notEqual(url.href, oldUrl);
      const reattached = await state();
      assert.equal(reattached.busy, true);
      assert.equal(reattached.sessionName, "Browser-renamed session");
      assert.equal(faux.state.callCount, 1);
    }
    finishReply();
    await session.waitForIdle();
    session.setSessionName("Renamed browser chat");
    const finished = await state(`?after=${working.cursor}`);
    assert.equal(finished.busy, false);
    assert.equal(finished.sessionName, "Renamed browser chat");
    const [reply] = finished.messages;
    assert.match(reply.html, /<strong>answer<\/strong>/);
    const start = reply.text.indexOf("answer");
    const image = { name: "picture.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC" };
    const batch = {
      requestId: "c5562ee8-daca-4e02-bc16-66d5f1c53289",
      annotations: [{ responseId: reply.id, start, end: start + 6, quote: "answer", comment: "Explain.", images: [image] }],
    };
    assert.equal((await send(batch)).status, 200, JSON.stringify(errors));
    assert.equal((await send(batch)).status, 200, "retry acknowledges the original send");
    await session.waitForIdle();
    const followUp = await state(`?after=${finished.cursor}`);
    assert.deepEqual(followUp.messages.map(({ role }) => role), ["user", "assistant"]);
    assert.match(followUp.messages[0].text, /> answer\n\nExplain\.\n\nAttached: Image 1\./);
    assert.equal(followUp.messages[0].imageCount, 1);
    assert.match(followUp.messages[1].text, /more detail/);
    assert.equal(faux.state.callCount, 2);
    const file = { name: "notes.md", mimeType: "text/markdown", data: Buffer.from("# Notes\nHello.").toString("base64") };
    const picture = {
      requestId: "423835d4-c14d-4b80-8cd0-4bcf3eb61935", text: "Look at this picture",
      attachments: [image, file, { ...image, name: "second.png" }],
    };
    settingsManager.setBlockImages(true);
    const blocked = await send(picture);
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /Images are disabled/);
    assert.equal((await send({ requestId: "49cda6e1-0914-4c13-9369-84e400e3e6c9", text: "", attachments: [file] })).status, 200);
    await session.waitForIdle();
    const afterText = await state(`?after=${followUp.cursor}`);
    assert.match(afterText.messages[0].text, /Attached file: "notes.md"/);
    settingsManager.setBlockImages(false);
    assert.equal((await send(picture)).status, 200, JSON.stringify(errors));
    await session.waitForIdle();
    assert.match(imagePrompt.content[0].text, /Look at this picture[\s\S]*# Notes\nHello\./);
    assert.deepEqual(imagePrompt.content.slice(1).map(({ type, mimeType }) => [type, mimeType]), [["image", "image/png"], ["image", "image/png"]]);
    const afterImage = await state(`?after=${afterText.cursor}`);
    const imageMessage = afterImage.messages[0];
    assert.equal(imageMessage.imageCount, 2);
    assert.doesNotMatch(imageMessage.text, /\[Image attached\]/);
    assert.doesNotMatch(JSON.stringify(afterImage), /iVBORw0KGgo/);
    const imageUrl = `${url.origin}/api/image?${new URLSearchParams({ id: imageMessage.id, index: "1" })}`;
    assert.equal((await fetch(imageUrl)).status, 401);
    const preview = await fetch(imageUrl, { headers });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await preview.arrayBuffer()).toString("base64"), image.data);
    const saved = ["project-one", "project-two"].map((project) => {
      const manager = SessionManager.create(join(cwd, project));
      const entryId = manager.appendMessage({ role: "user", content: [{ type: "image", mimeType: image.mimeType, data: image.data }], timestamp: Date.now() });
      manager.appendMessage(fauxAssistantMessage(`Saved reply for **${project}**.`));
      manager.appendSessionInfo(project === "project-one" ? "Renamed browser chat" : project);
      return { manager, entryId };
    });
    const savedFile = saved[0].manager.getSessionFile();
    const beforeBrowse = await readFile(savedFile);
    const get = (path) => fetch(`${url.origin}${path}`, { headers });
    const listing = await get("/api/sessions");
    const catalog = await listing.json();
    assert.equal(listing.status, 200, JSON.stringify(catalog));
    assert.equal(catalog.current.name, "Renamed browser chat");
    assert.deepEqual(catalog.sessions.map(({ cwd: directory }) => directory).sort(), saved.map(({ manager }) => manager.getCwd()).sort());
    const id = saved[0].manager.getSessionId();
    const savedState = await get(`/api/session?${new URLSearchParams({ id })}`);
    const snapshot = await savedState.json();
    assert.equal(savedState.status, 200, JSON.stringify(snapshot));
    assert.match(snapshot.messages[1].html, /<strong>project-one<\/strong>/);
    const savedImage = await get(`/api/image?${new URLSearchParams({ id: saved[0].entryId, index: "0", session: id })}`);
    assert.equal(savedImage.status, 200);
    assert.equal(Buffer.from(await savedImage.arrayBuffer()).toString("base64"), image.data);
    assert.deepEqual(await readFile(savedFile), beforeBrowse);
    assert.equal(catalog.sessions.find((session) => session.id === id).name, catalog.current.name);
    await rm(savedFile);
    const refreshed = await get("/api/sessions");
    assert.equal(refreshed.status, 200);
    const updated = await refreshed.json();
    assert.equal(updated.current.name, catalog.current.name);
    assert.deepEqual(updated.sessions.map(({ id }) => id), [saved[1].manager.getSessionId()]);
    assert.equal((await get(`/api/session?${new URLSearchParams({ id })}`)).status, 404);
    assert.equal(faux.state.callCount, 4);
    assert.deepEqual(errors, []);
  } finally {
    finishReply();
    await session.waitForIdle();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});
