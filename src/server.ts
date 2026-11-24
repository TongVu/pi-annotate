import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { CHAT_BODY_LIMIT } from "./chat-attachments.ts";
import { createChatCatalog } from "./chat-catalog.ts";
import { CHAT_NOTE_LIMIT } from "./chat-notes.ts";
import { createLiveChat } from "./live-chat.ts";
import { isLocalRequest, isSameOriginJson, setLocalPageHeaders } from "./loopback-http.ts";
import { renderMarkdown } from "./markdown.ts";
import { readWebAsset } from "./web-assets.ts";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8", "tooltips.js"],
  "/chat/page.js": ["chat/page.js", "text/javascript; charset=utf-8"],
  "/chat/explorer.js": ["chat/explorer.js", "text/javascript; charset=utf-8"],
  "/chat/transcript.js": ["chat/transcript.js", "text/javascript; charset=utf-8"],
  "/chat/send.js": ["chat/send.js", "text/javascript; charset=utf-8"],
  "/chat/composer.js": ["chat/composer.js", "text/javascript; charset=utf-8"],
  "/chat/composer-controls.js": ["chat/composer-controls.js", "text/javascript; charset=utf-8"],
  "/chat/annotations.js": ["chat/annotations.js", "text/javascript; charset=utf-8"],
  "/chat/attachments.js": ["chat/attachments.js", "text/javascript; charset=utf-8"],
  "/chat/notes.js": ["chat/notes.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8", "tooltips.css"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/logo.png": ["logo.png", "image/png"],
};
const NOTE_BODY_LIMIT = 256 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request is too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request cancelled.")));
  });
}

/** Loopback only; no direct model calls, session-file writes, cookies, or CORS. */
export async function startChatServer({ chat, onClose, isCurrent = () => true, ttlMs = 30 * 60_000 }) {
  const live = createLiveChat(chat);
  const presence = chat.presence;
  const explorer = chat.explorer && createChatCatalog(chat.explorer, presence);
  const reopenCommand = "/chat";
  const token = randomBytes(32).toString("hex");
  const landing = `/?tab=${randomBytes(16).toString("hex")}`;
  let origin;
  let activityTimer;
  let expired = false;
  const publishActivity = (heartbeat) => presence?.touch?.(ttlMs, { status: live.status(), tab: origin + landing }, heartbeat);
  const server = createServer(async (req, res) => {
    setLocalPageHeaders(res, { embeddedImages: true });
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      if (!isLocalRequest(req.headers, origin)) {
        reply(403, { error: "Only this local chat page may connect." });
        return;
      }
      const checkCurrent = () => {
        if (!expired && isCurrent()) return true;
        reply(410, { error: `This browser page expired or its Pi session/branch changed. Run ${reopenCommand} again.` });
        return false;
      };
      if (!checkCurrent()) return;
      const asset = Object.hasOwn(assets, req.url) ? assets[req.url] : req.url === landing ? assets["/"] : undefined;
      if (req.method === "GET" && asset) {
        const [file, type, prefix] = asset;
        const data = await readWebAsset(file, prefix);
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(401, { error: "Missing or invalid chat token. Reopen from Pi." });
        return;
      }
      const url = new URL(req.url, origin);
      if (live && req.method === "GET" && url.pathname === "/api/note") {
        const markdown = await live.readNote();
        if (checkCurrent()) reply(200, { markdown });
        return;
      }
      if (live && req.method === "GET" && url.pathname === "/api/activity") {
        const sessions = await presence?.list() ?? [];
        explorer?.noteActive(sessions);
        if (checkCurrent()) reply(200, { sessions });
        return;
      }
      if (explorer && req.method === "GET" && url.pathname === "/api/sessions") {
        const data = await explorer.list();
        if (checkCurrent()) reply(200, data);
        return;
      }
      if (explorer && req.method === "GET" && url.pathname === "/api/session/resume") {
        const command = explorer.resumeCommand(url.searchParams.get("id"));
        reply(command ? 200 : 404, command ? { command } : { error: "Resume command unavailable. Refresh the explorer." });
        return;
      }
      if (explorer && req.method === "GET" && url.pathname === "/api/session") {
        const data = await explorer.transcript(url.searchParams.get("id"));
        if (checkCurrent()) reply(data ? 200 : 404, data ?? { error: "Saved session not found. Refresh the explorer." });
        return;
      }
      if (live && req.method === "GET" && url.pathname === "/api/image") {
        const id = url.searchParams.get("id");
        const index = url.searchParams.get("index");
        const session = url.searchParams.get("session");
        const image = session === null ? live.image(id, index) : await explorer?.image(session, id, index);
        if (!checkCurrent()) return;
        if (!image) reply(404, { error: "Image unavailable." });
        else {
          res.writeHead(200, { "Content-Type": image.mimeType });
          res.end(image.bytes);
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/response") {
        timer.refresh(); // An authenticated poll keeps a chat alive.
        if (presence?.touch && !activityTimer) {
          // Background tabs may be throttled. Pi itself publishes status changes.
          activityTimer = setInterval(() => {
            if (isCurrent()) void publishActivity(false);
            else close();
          }, 1000);
          activityTimer.unref();
        }
        await publishActivity(true);
        if (checkCurrent()) live.read(url.searchParams.get("after"), reply);
        return;
      }
      const modelSettings = req.url === "/api/session/model";
      if (req.method === "GET" && modelSettings) {
        await live.modelSettings(reply, checkCurrent);
        return;
      }
      const disconnect = live && req.url === "/api/close";
      const renameSession = live && req.url === "/api/session/name";
      const compactSession = live && req.url === "/api/session/compact";
      const localAction = req.url === "/api/session/focus-terminal" ? { name: "Switch to Terminal", run: chat.focusTerminal }
        : req.url === "/api/dashboard/open" ? { name: "Open dashboard", run: chat.openDashboard && (() => chat.openDashboard(req.headers["user-agent"] ?? "")) } : undefined;
      const renderNote = live && req.url === "/api/markdown";
      const saveNote = live && req.url === "/api/note";
      const openSession = explorer && req.url === "/api/session/open";
      const cloneSession = explorer && req.url === "/api/session/clone";
      if (req.method === "POST" && (disconnect || renameSession || compactSession || modelSettings || localAction || renderNote || saveNote || openSession || cloneSession || req.url === "/api/chat")) {
        if (!isSameOriginJson(req.headers, origin)) {
          reply(403, { error: "Expected a same-origin JSON request." });
          return;
        }
        if (disconnect) {
          const raw = await readBody(req, NOTE_BODY_LIMIT);
          const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
          if (body?.markdown !== undefined) {
            if (!checkCurrent()) return;
            await live.saveNote(body.markdown);
            if (!checkCurrent()) return;
          }
          res.once("finish", close);
          reply(200, { ok: true });
          return;
        }
        const raw = await readBody(req, renderNote || saveNote ? NOTE_BODY_LIMIT : openSession || renameSession || compactSession || modelSettings || localAction || cloneSession ? 4096 : CHAT_BODY_LIMIT);
        const body = JSON.parse(raw.toString("utf8"));
        if (modelSettings) {
          if (!body || typeof body !== "object" || Object.keys(body).length !== 1 ||
              ![body.model, body.effort].some((value) => typeof value === "string" && value.length > 0)) {
            throw new Error("Choose a model or thinking effort.");
          }
          if (checkCurrent()) await live.modelSettings(reply, checkCurrent, body);
          return;
        }
        if (compactSession) {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
            throw new Error("Compact chat does not accept a target.");
          }
          if (checkCurrent() && await live.compact(reply) && checkCurrent()) reply(200, { ok: true });
          return;
        }
        if (localAction) {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
            throw new Error(`${localAction.name} does not accept a target.`);
          }
          if (!checkCurrent()) return;
          if (!localAction.run) {
            reply(501, { error: `${localAction.name} is unavailable for this chat.` });
            return;
          }
          await localAction.run();
          if (checkCurrent()) reply(200, { ok: true });
          return;
        }
        if (saveNote) {
          if (!checkCurrent()) return;
          await live.saveNote(body?.markdown);
          if (checkCurrent()) reply(200, { ok: true });
          return;
        }
        if (renderNote) {
          if (typeof body?.markdown !== "string" || body.markdown.length > CHAT_NOTE_LIMIT) throw new Error(`Markdown notes must be ${CHAT_NOTE_LIMIT.toLocaleString()} characters or less.`);
          if (checkCurrent()) reply(200, renderMarkdown(body.markdown));
          return;
        }
        if (renameSession) {
          if (checkCurrent()) live.rename(body?.name, reply);
          return;
        }
        if (openSession) {
          if (checkCurrent()) await explorer.open(body?.id, reply, checkCurrent);
          return;
        }
        if (cloneSession) {
          if (checkCurrent()) await explorer.cloneSession(body?.id, reply, checkCurrent);
          return;
        }
        if (raw.length > CHAT_BODY_LIMIT) throw new Error("Request is too large.");
        // Check again after awaiting the request body; Pi may have changed sessions.
        if (expired || !isCurrent()) {
          reply(410, { error: `Pi session/branch changed. Run ${reopenCommand} again.` });
          return;
        }
        await live.send(body, reply);
        return;
      }
      reply(404, { error: "Not found." });
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : "Request failed." });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => {
    if (expired) return;
    expired = true;
    clearTimeout(timer);
    clearInterval(activityTimer);
    server.close();
    server.closeAllConnections();
    void presence?.close();
    onClose?.();
  };
  const timer = setTimeout(close, ttlMs);
  timer.unref();
  return { url: `${origin}${landing}#${token}`, close };
}
