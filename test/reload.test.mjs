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
test("Pi reload picks up changed local helper modules in the same process for /chat", {
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
    await extension.commands.get("chat").handler("link", {
      mode: "tui", isIdle: () => true, getContextUsage: () => undefined,
      sessionManager: {
        getSessionId: () => "reload-session",
        getSessionName: () => undefined,
        getSessionDir: () => join(directory, "sessions"),
        getCwd: () => directory,
        getSessionFile: () => undefined,
        getBranch: () => [{ id: "reload-response", type: "message", message: {
          role: "assistant", content: [{ type: "text", text: "**Bold** response" }],
        } }],
      },
      ui: { notify: (message) => { if (message.includes("http://127.0.0.1:")) link = message.split(": ").at(-1); } },
    });
    const url = new URL(link);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    const response = await (await fetch(`${url.origin}/api/response`, { headers })).json();
    assert.equal(response.mode, "chat");
    assert.match(response.messages[0].text, /^Bold response\n/);
    assert.equal(JSDOM.fragment(response.messages[0].html).textContent, response.messages[0].text);
    return { response, url, headers };
  };

  const before = await run();
  assert.equal(before.response.messages[0].text, "Bold response\n");
  await shutdown();
  const helper = join(directory, "src/markdown.ts");
  const source = await readFile(helper, "utf8");
  const needle = "const html = markdown.parse(source);";
  assert.ok(source.includes(needle));
  await writeFile(helper, source.replace(needle, 'const html = markdown.parse(source + "\\n\\nReload marker.");'));
  clearExtensionCache();

  const after = await run();
  assert.match(after.response.messages[0].text, /Reload marker/);
  const responseState = await fetch(`${after.url.origin}/api/response`, { headers: after.headers });
  assert.match((await responseState.json()).messages[0].text, /Reload marker/);
});

test("Pi branches a saved reply into a named child without replacing the parent chat", {
  skip: !loaderPath || process.platform !== "linux" ? "Requires the installed Pi loader and Linux for the Kitty launch fixture" : false,
}, async (t) => {
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const { SessionManager } = await import(new URL("../../index.js", pathToFileURL(loaderPath)));
  const { fauxAssistantMessage } = await import(new URL("../../../../pi-ai/dist/index.js", pathToFileURL(loaderPath)));
  if (!fauxAssistantMessage) return t.skip("Requires Pi's faux provider");
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-branch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const launchLog = join(cwd, "kitty-argv");
  await writeFile(join(cwd, "kitty"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$TEST_LAUNCH_LOG"\n`, { mode: 0o755 });
  await writeFile(join(cwd, "pi"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = { PI_CODING_AGENT_DIR: cwd, PI_MANAGED_INSTALL_ROOT: undefined, KITTY_WINDOW_ID: "27", KITTY_LISTEN_ON: `unix:${join(cwd, "socket")}`,
    KITTY_CONFIG_DIRECTORY: cwd, PATH: cwd, TMUX: undefined, STY: undefined, SSH_CONNECTION: undefined, TEST_LAUNCH_LOG: launchLog };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    const set = (v) => { if (v === undefined) delete process.env[key]; else process.env[key] = v; };
    set(value);
    t.after(() => set(previous));
  }
  const parent = SessionManager.create(cwd, join(cwd, "sessions-store"));
  parent.appendSessionInfo("Stage Aura changes");
  const userId = parent.appendMessage({ role: "user", content: "What broke?", timestamp: Date.now() });
  const firstReply = parent.appendMessage(fauxAssistantMessage("The compile error comes from a missing import."));
  const abandoned = parent.appendMessage(fauxAssistantMessage("This reply belongs to an abandoned path."));
  parent.branch(firstReply);
  parent.appendMessage({ role: "user", content: "What about the tests?", timestamp: Date.now() });
  const latest = parent.appendMessage(fauxAssistantMessage("Later reply stays in the parent."));
  const parentPath = parent.getSessionFile();
  const parentContents = await readFile(parentPath, "utf8");
  const path = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([path], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  t.after(async () => { for (const close of extension.handlers.get("session_shutdown")) await close({}, {}); });
  async function connect(sessionManager) {
    let link;
    await extension.commands.get("chat").handler("link", {
      mode: "tui", isIdle: () => true, getContextUsage: () => undefined, sessionManager,
      ui: { notify: (message) => { if (message.includes("http://127.0.0.1:")) link = message.split(": ").at(-1); } },
    });
    const url = new URL(link);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    return {
      get: async (path) => {
        const response = await fetch(url.origin + path, { headers });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      },
      branch: (replyId, name, extraHeaders = {}) => fetch(`${url.origin}/api/session/branch`, {
        method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ replyId, name }),
      }),
    };
  }
  const live = await connect(parent);
  const initial = await live.get("/api/response");
  assert.equal(initial.messages.find(({ id }) => id === firstReply).canBranch, true);
  assert.equal((await live.branch(firstReply, "Child", { Authorization: "" })).status, 401);
  assert.equal((await live.branch(firstReply, "Child", { Origin: "https://example.com" })).status, 403);
  assert.equal((await live.branch(userId, "Child")).status, 404);
  assert.equal((await live.branch(abandoned, "Child")).status, 404);
  assert.equal((await live.branch(firstReply, " ")).status, 400);
  const created = await live.branch(firstReply, "Fix Aura compile error");
  assert.equal(created.status, 202, await created.clone().text());
  assert.deepEqual(await created.json(), { launched: true });
  assert.equal(await readFile(parentPath, "utf8"), parentContents);
  assert.equal(parent.getLeafId(), latest);
  assert.deepEqual(await live.get("/api/response"), initial, "the parent remains connected and unchanged");
  const { sessions } = await live.get("/api/sessions");
  assert.deepEqual(sessions.map(({ parentId, name }) => ({ parentId, name })), [{ parentId: parent.getSessionId(), name: "Fix Aura compile error" }]);
  const launchArgs = (await readFile(launchLog, "utf8")).trimEnd().split("\n");
  const childPath = launchArgs[launchArgs.indexOf("--session") + 1];
  assert.ok(launchArgs.includes("--type=tab"));
  assert.ok(launchArgs.includes(`${AUTO_CHAT_SESSION}=${sessions[0].id}`));
  const child = SessionManager.open(childPath);
  assert.notEqual(child.getSessionId(), parent.getSessionId());
  assert.equal(child.getHeader().parentSession, parentPath);
  assert.deepEqual(child.getBranch().filter(({ type }) => type === "message").map(({ id }) => id), [userId, firstReply]);
  const childLive = await connect(child);
  const childState = await childLive.get("/api/response");
  assert.equal(childState.sessionName, "Fix Aura compile error");
  assert.deepEqual(childState.subchatOrigin, { replyId: firstReply, parentName: "Stage Aura changes" });
  assert.equal((await childLive.get("/api/sessions")).current.parentId, parent.getSessionId());

  delete process.env.KITTY_LISTEN_ON;
  const noLauncher = await connect(parent);
  const manual = await noLauncher.branch(latest, "Review staged changes");
  assert.equal(manual.status, 200, await manual.clone().text());
  assert.match((await manual.json()).command, /^cd -- .* && pi --session /);
  assert.ok((await noLauncher.get("/api/sessions")).sessions.some(({ name }) => name === "Review staged changes"));
});

test("Pi --dashboard opens the dashboard at startup without advertising the launcher as a chat", {
  skip: !loaderPath && "Requires an installed Pi loader",
  timeout: 10000,
}, async (t) => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(new URL("../../index.js", pathToFileURL(loaderPath)));
  const { parseArgs } = await import(new URL("../../cli/args.js", pathToFileURL(loaderPath)));
  const { fauxProvider } = await import(new URL("../../../../pi-ai/dist/index.js", pathToFileURL(loaderPath)));
  if (!ModelRuntime || !fauxProvider) return t.skip("Requires Pi's ModelRuntime and faux provider");
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-dashboard-startup-"));
  const agentDir = join(cwd, "agent");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });
  const faux = fauxProvider({ provider: "dashboard-startup-test", models: [{ id: "test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const openLog = join(cwd, "dashboard-url");
  const adapter = join(cwd, "dashboard-launch.ts");
  const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  await writeFile(adapter, `
    import { writeFile } from "node:fs/promises";
    import { registerChatExtension } from ${JSON.stringify(extensionPath)};
    export default function (pi) {
      registerChatExtension(pi, (url) => writeFile(${JSON.stringify(openLog)}, url));
    }
  `);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [adapter] });
  await resourceLoader.reload();
  const parsed = parseArgs(["--dashboard"]);
  assert.equal(parsed.unknownFlags.get("dashboard"), true);
  assert.ok(parseArgs(["-dashboard"]).diagnostics.some(({ message }) => message.includes("Unknown option")));
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), noTools: true,
  });
  for (const [name, value] of parsed.unknownFlags) session.extensionRunner.setFlagValue(name, value);
  const errors = [];
  let dashboard;
  try {
    await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error) });
    dashboard = new URL(await readFile(openLog, "utf8"));
    const res = await fetch(`${dashboard.origin}/api/dashboard`, {
      headers: { Authorization: `Bearer ${dashboard.hash.slice(1)}` }, signal: AbortSignal.timeout(3000),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { projects: [cwd], sessions: [], supportsBookmarks: true, canFocusTerminal: true });
    assert.equal(faux.state.callCount, 0);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  await assert.rejects(() => fetch(dashboard.origin, { signal: AbortSignal.timeout(3000) }));
});

test("installed Pi accepts a browser prompt before the model finishes, then exposes the reply", {
  skip: !loaderPath && "Requires an installed Pi loader",
  timeout: 10000,
}, async (t) => {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(new URL("../../index.js", pathToFileURL(loaderPath)));
  if (!ModelRuntime) return t.skip("Requires Pi's ModelRuntime and faux provider");
  const { fauxProvider, fauxAssistantMessage } = await import(new URL("../../../../pi-ai/dist/index.js", pathToFileURL(loaderPath)));
  if (!fauxProvider) return t.skip("Requires Pi's faux provider");
  const cwd = await mkdtemp(join(tmpdir(), "pi-chat-reload-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "explorer-agent");
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const faux = fauxProvider({ provider: "chat-test", models: [
    { id: "vision", input: ["text", "image"] }, { id: "reasoner", reasoning: true }, { id: "out-of-scope" },
  ] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel("vision");
  const reasoner = faux.getModel("reasoner");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 },
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "medium" });
  const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const adapter = join(cwd, "test-chat-launch.ts");
  const openLog = join(cwd, "browser-url");
  await writeFile(adapter, `
    import { writeFile } from "node:fs/promises";
    import { registerChatExtension } from ${JSON.stringify(extensionPath)};
    export default function (pi) {
      registerChatExtension(pi, (url) => writeFile(${JSON.stringify(openLog)}, url));
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
    sessionManager, noTools: true, scopedModels: [{ model }, { model: reasoner }],
  });
  const previousTarget = process.env[AUTO_CHAT_SESSION];
  process.env[AUTO_CHAT_SESSION] = sessionManager.getSessionId();
  t.after(() => {
    if (previousTarget === undefined) delete process.env[AUTO_CHAT_SESSION];
    else process.env[AUTO_CHAT_SESSION] = previousTarget;
  });
  let link;
  let dashboard;
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
    const compact = () => fetch(`${url.origin}/api/session/compact`, {
      method: "POST", headers, body: "{}", signal: AbortSignal.timeout(3000),
    });
    const modelKey = (id) => JSON.stringify([model.provider, id]);
    const modelUrl = () => `${url.origin}/api/session/model`;
    const modelSettings = async () => {
      const result = await fetch(modelUrl(), { headers });
      assert.equal(result.status, 200, await result.clone().text());
      return result.json();
    };
    const changeModel = (body, extra = {}) => fetch(modelUrl(), {
      method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
    });
    assert.equal((await fetch(modelUrl())).status, 401);
    const initialModel = await modelSettings();
    assert.equal(initialModel.model.key, modelKey("vision"));
    assert.deepEqual(initialModel.models.map(({ key }) => key), [modelKey("vision"), modelKey("reasoner")]);
    assert.deepEqual(initialModel.efforts, ["off"]);
    assert.equal((await changeModel({ model: modelKey("out-of-scope") })).status, 400);
    assert.equal((await changeModel({ effort: "high" })).status, 400);
    assert.equal((await changeModel({ model: modelKey("reasoner"), effort: "high" })).status, 400);
    assert.equal((await changeModel({ model: modelKey("reasoner") }, { Origin: "" })).status, 403);
    assert.equal((await state()).canCompact, false);
    assert.equal((await send({ requestId: "e126ac9d-7780-4853-8de2-5d6d0a869093", text: "/literal question" })).status, 200, JSON.stringify(errors));
    const working = await state();
    assert.equal(working.busy, true);
    assert.equal((await compact()).status, 409);
    assert.equal((await changeModel({ model: modelKey("reasoner") })).status, 409);
    assert.equal((await modelSettings()).model.key, modelKey("vision"));
    assert.equal(working.sessionName, "Live browser chat feature");
    assert.deepEqual(working.messages.map(({ role, text }) => [role, text]), [["user", "Transformed: /literal question\n"]]);
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
    assert.match(followUp.messages[0].html, /<blockquote>\s*<p>answer<\/p>\s*<\/blockquote>\s*<p>Explain\.<\/p>\s*<p>Attached: Image 1\.<\/p>/);
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
    const log = "\x1b[91mBuild failed\x1b[0m\n".padEnd(512 * 1024 + 1, "x");
    const consoleText = { name: "consoleText", mimeType: "", data: Buffer.from(log).toString("base64") };
    const received = await send({ requestId: "49cda6e1-0914-4c13-9369-84e400e3e6c9", text: "", attachments: [consoleText] });
    assert.equal(received.status, 200, await received.clone().text());
    await session.waitForIdle();
    const afterText = await state(`?after=${followUp.cursor}`);
    assert.match(afterText.messages[0].text, /Attached file: "consoleText"/);
    assert.doesNotMatch(afterText.messages[0].text, /Build failed/);
    const logReference = sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user").message.content[0].text;
    const logPath = JSON.parse(logReference.match(/^Local path: (.*)$/m)[1]);
    assert.equal(await readFile(logPath, "utf8"), log);
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
    const dashboardLaunch = await fetch(`${url.origin}/api/dashboard/open`, { method: "POST", headers, body: "{}" });
    assert.equal(dashboardLaunch.status, 200, await dashboardLaunch.clone().text());
    dashboard = new URL(await readFile(openLog, "utf8"));
    assert.notEqual(dashboard.origin, url.origin);
    await session.prompt("/chat dashboard");
    assert.equal(link, dashboard.href, "the command and explorer button share one dashboard server");
    const dashboardState = () => fetch(`${dashboard.origin}/api/dashboard`, {
      headers: { Authorization: `Bearer ${dashboard.hash.slice(1)}` }, signal: AbortSignal.timeout(3000),
    });
    const response = await dashboardState();
    assert.equal(response.status, 200);
    const { sessions, canFocusTerminal } = await response.json();
    assert.equal(canFocusTerminal, true);
    assert.equal(sessions.find(({ id }) => id === sessionManager.getSessionId())?.status, "ready");
    assert.equal(sessions.find(({ id }) => id === saved[1].manager.getSessionId())?.status, "saved");
    assert.equal(faux.state.callCount, 4);
    const beforeCompaction = await state();
    assert.equal(beforeCompaction.canCompact, true);
    assert.ok(beforeCompaction.contextUsage.tokens > 0);
    assert.equal(beforeCompaction.contextUsage.contextWindow, model.contextWindow);
    faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage("Summary of the earlier conversation.")));
    const compacted = await compact();
    assert.equal(compacted.status, 200, await compacted.clone().text());
    assert.match(sessionManager.getBranch().at(-1).summary, /Summary of the earlier conversation/);
    const afterCompaction = await state();
    assert.notEqual(afterCompaction.cursor, beforeCompaction.cursor);
    assert.deepEqual(afterCompaction.messages, beforeCompaction.messages);
    assert.equal(afterCompaction.contextUsage.tokens, null);
    const switched = await changeModel({ model: modelKey("reasoner") });
    assert.equal(switched.status, 200, await switched.clone().text());
    assert.ok((await switched.json()).efforts.includes("high"));
    const effortChanged = await changeModel({ effort: "high" });
    assert.equal(effortChanged.status, 200, await effortChanged.clone().text());
    assert.equal((await effortChanged.json()).effort, "high");
    assert.equal(session.model.id, "reasoner");
    assert.equal(session.thinkingLevel, "high");
    assert.equal(settingsManager.getDefaultModel(), "vision");
    assert.equal(settingsManager.getDefaultThinkingLevel(), "medium");
    await session.prompt("/chat close");
    assert.equal(await readFile(logPath, "utf8"), log, "closing the browser chat preserves the attachment for later turns");
    assert.equal((await dashboardState()).status, 200);
    await assert.rejects(() => get("/api/response"));
    if (process.platform !== "win32") {
      const terminalState = async () => (await (await dashboardState()).json()).sessions
        .find(({ id }) => id === sessionManager.getSessionId());
      assert.equal((await terminalState()).status, "disconnected");
      assert.equal((await terminalState()).terminalWorking, undefined);
      const gate = Promise.withResolvers();
      faux.setResponses([async () => {
        await gate.promise;
        return fauxAssistantMessage("Terminal reply.");
      }]);
      const turn = session.prompt("Work from Terminal with no chat tab");
      try {
        let working;
        for (let attempt = 0; attempt < 60; attempt++) {
          working = await terminalState();
          if (working.terminalWorking) break;
          await delay(25);
        }
        assert.equal(working.status, "disconnected");
        assert.equal(working.terminalWorking, true);
        assert.equal(working.action, "reopen");
      } finally {
        gate.resolve();
        await turn;
        await session.waitForIdle();
      }
      const idle = await terminalState();
      assert.equal(idle.status, "disconnected");
      assert.equal(idle.terminalWorking, undefined);
    }
    assert.deepEqual(errors, []);
  } finally {
    finishReply();
    await session.waitForIdle();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  if (dashboard) await assert.rejects(() => fetch(dashboard.origin, { signal: AbortSignal.timeout(3000) }));
});
