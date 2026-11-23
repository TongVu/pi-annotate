import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChatExtension } from "../src/index.ts";

function fixture(t, { newSession = async () => ({ cancelled: false }), launchPage = async () => {} } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  registerChatExtension({
    on: (event, callback) => handlers.set(event, callback),
    registerCommand: (name, options) => commands.set(name, options),
    setSessionName: () => {},
    getSettings: () => ({}),
    sendUserMessage: () => {},
  }, launchPage);
  t.after(() => handlers.get("session_shutdown")());
  const ctx = {
    mode: "tui",
    isIdle: () => true,
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => "/tmp/pi-chat-extension-tests",
      getSessionId: () => "session-1",
      getSessionName: () => undefined,
      getCwd: () => process.cwd(),
      getSessionFile: () => undefined,
    },
    newSession,
    ui: { notify: (message) => notices.push(message) },
  };
  return { handlers, notices, ctx, commands, run: (args = "link") => commands.get("chat").handler(args, ctx) };
}

function openedUrl(notices) {
  return new URL(notices.findLast((message) => message.includes("http://127.0.0.1:")).split(": ").at(-1));
}

test("/chat is the sole registered browser command and opens a live session", async (t) => {
  const f = fixture(t);
  assert.deepEqual([...f.commands.keys()], ["chat"]);
  assert.deepEqual(f.commands.get("chat").getArgumentCompletions("").map(({ value }) => value), ["link", "close"]);
  await f.run();
  const url = openedUrl(f.notices);
  const response = await fetch(`${url.origin}/api/response`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } });
  assert.equal((await response.json()).mode, "chat");
  await f.run("close");
  await assert.rejects(() => fetch(url.origin));
});

test("new chat from the browser replaces the current Pi session and opens its new chat page", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-chat-new-session-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  const opened = [];
  let sessionId = "session-1";
  const f = fixture(t, {
    launchPage: async (url) => opened.push(url),
    newSession: async ({ withSession }) => {
      sessionId = "session-2";
      const next = {
        ...f.ctx,
        newSession: f.ctx.newSession,
        sessionManager: { ...f.ctx.sessionManager, getSessionId: () => sessionId },
      };
      await withSession(next);
      return { cancelled: false };
    },
  });
  f.ctx.sessionManager.getSessionDir = () => sessionDir;
  await f.run("link");
  const url = openedUrl(f.notices);
  const accepted = await fetch(`${url.origin}/api/session/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opened.length, 1);
  assert.notEqual(new URL(opened[0]).origin, url.origin);
  assert.equal(sessionId, "session-2");
});

test("/chat rejects unsupported modes and non-TUI contexts", async (t) => {
  const f = fixture(t);
  await f.run("unknown");
  assert.match(f.notices.at(-1), /Usage: \/chat/);
  f.ctx.mode = "rpc";
  await f.run();
  assert.match(f.notices.at(-1), /terminal UI/);
});
