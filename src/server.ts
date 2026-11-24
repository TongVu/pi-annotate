import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { MAX_ANNOTATIONS, formatChatAnnotations, userImageBlocks, visibleChatMessage } from "./annotations.ts";
import { renderMarkdown } from "./markdown.ts";
import { shellQuote } from "./resume-chat.ts";
import { CHAT_NOTE_LIMIT } from "./chat-notes.ts";
import { readWebAsset } from "./web-assets.ts";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8", "tooltips.js"],
  "/style.css": ["style.css", "text/css; charset=utf-8", "tooltips.css"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/logo.png": ["logo.png", "image/png"],
};
const BODY_LIMIT = 512 * 1024;
const MAX_ATTACHMENTS = 10;
const FILE_LIMIT = 5 * 1024 * 1024;
const ATTACHMENTS_LIMIT = 10 * 1024 * 1024;
const TEXT_FILES_LIMIT = 128 * 1024;
const FILE_BASE64_LIMIT = Math.ceil(FILE_LIMIT / 3) * 4;
const CHAT_BODY_LIMIT = BODY_LIMIT + Math.ceil(ATTACHMENTS_LIMIT / 3) * 4 + MAX_ATTACHMENTS * 4;
const NOTE_BODY_LIMIT = 256 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

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

function imageMimeType(bytes) {
  const header = bytes.toString("latin1", 0, 12);
  if (header.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (header.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (/^GIF8[79]a/.test(header)) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP") return "image/webp";
  return undefined;
}

function attachmentBlocks(files, imagesOnly = false) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach between 1 and ${MAX_ATTACHMENTS} files.`);
  }
  let total = 0;
  let textTotal = 0;
  return files.map((file) => {
    const { name, mimeType, data } = file ?? {};
    if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\x00-\x1f/\\]/.test(name) ||
        typeof mimeType !== "string" || mimeType.length > 100 || typeof data !== "string" || data.length > FILE_BASE64_LIMIT) {
      throw new Error("Invalid attachment or file over 5 MiB.");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > FILE_LIMIT || bytes.toString("base64") !== data) throw new Error("Invalid file data or file over 5 MiB.");
    total += bytes.length;
    if (total > ATTACHMENTS_LIMIT) throw new Error("Attachments must be 10 MiB or less in total.");
    const imageType = imageMimeType(bytes);
    if (mimeType.startsWith("image/") && mimeType !== imageType) {
      throw new Error(`${name}: expected a valid PNG, JPEG, GIF, or WebP image.`);
    }
    if (imageType) return { type: "image", mimeType: imageType, data };
    if (imagesOnly) throw new Error(`${name}: annotations accept only PNG, JPEG, GIF, or WebP images.`);
    textTotal += bytes.length;
    if (textTotal > TEXT_FILES_LIMIT) throw new Error("Text attachments must be 128 KiB or less in total.");
    let text;
    try { text = utf8.decode(bytes); } catch { /* unsupported binary or encoding */ }
    if (text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || mimeType === "application/pdf" || text.startsWith("%PDF-")) {
      throw new Error(`${name}: only UTF-8 text files and PNG, JPEG, GIF, or WebP images are supported.`);
    }
    return { type: "text", text: `--- Attached file: ${JSON.stringify(name)} ---\n${text}\n--- End attached file ---` };
  });
}

function annotationImagesAt(annotations) {
  if (!Array.isArray(annotations) || annotations.length > MAX_ANNOTATIONS) return;
  const files = [];
  const ranges = new Map();
  for (const [index, item] of annotations.entries()) {
    if (item?.images === undefined) continue;
    if (!Array.isArray(item.images) || !item.images.length || files.length + item.images.length > MAX_ATTACHMENTS) {
      throw new Error(`Attach between 1 and ${MAX_ATTACHMENTS} images across the annotation batch.`);
    }
    const start = files.length;
    files.push(...item.images);
    ranges.set(index, [start, files.length]);
  }
  if (!files.length) return;
  const blocks = attachmentBlocks(files, true);
  return (index) => ranges.has(index) ? blocks.slice(...ranges.get(index)) : [];
}

function renderChatEntry(entry) {
  const message = visibleChatMessage(entry);
  return message && { ...message, ...renderMarkdown(message.text) };
}

function readChatImage(branch, id, index) {
  if (!id || !/^\d+$/.test(index ?? "")) return;
  const image = userImageBlocks(branch.find((entry) => entry.id === id))[Number(index)];
  if (!image || typeof image.data !== "string") return;
  const bytes = Buffer.from(image.data, "base64");
  if (imageMimeType(bytes) === image.mimeType) return { bytes, mimeType: image.mimeType };
}

function explorerRoutes({ current, list, read, launch, clone }, presence) {
  let catalog = new Map();
  let liveCloneSession;
  let saved;
  let listing;
  const opening = new Map();
  const cloning = new Map();
  const savedBranch = (id) => {
    const session = catalog.get(id);
    if (!session) return;
    if (saved?.id !== id) {
      const branch = read({ id: session.id, cwd: session.cwd, path: session.path, name: session.name }).catch(() => {
        if (saved?.branch === branch) saved = undefined;
        throw new Error("Could not read this saved Pi session.");
      });
      saved = { id, branch };
    }
    return saved.branch;
  };
  return {
    async list() {
      listing ??= list().catch(() => { throw new Error("Could not list saved Pi sessions."); })
        .finally(() => { listing = undefined; });
      const sessions = await listing;
      const live = current();
      const byPath = new Map(sessions.map((session) => [resolve(session.path), session.id]));
      const parentId = (session) => session?.parentSessionPath && byPath.get(resolve(session.parentSessionPath));
      const liveRecord = sessions.find(({ id }) => id === live.id) ??
        sessions.find(({ path }) => live.path && resolve(path) === resolve(live.path));
      const liveParent = parentId(liveRecord);
      liveCloneSession = liveRecord;
      catalog = new Map();
      saved = undefined;
      for (const session of sessions) {
        const { id, cwd, path, name, firstMessage } = session;
        if (id === live.id || catalog.has(id)) continue;
        const title = name?.trim() || firstMessage?.replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled session";
        const parent = parentId(session);
        catalog.set(id, { id, cwd, path, name: title, ...(parent ? { parentId: parent } : {}) });
      }
      return {
        current: { id: live.id, cwd: live.cwd, name: live.name, ...(liveParent ? { parentId: liveParent } : {}), ...(liveRecord && clone ? { canClone: true } : {}) },
        sessions: [...catalog.values()].filter(({ id }) => id !== live.id).map(({ id, cwd, name, parentId }) => ({ id, cwd, name, ...(parentId ? { parentId } : {}), ...(clone ? { canClone: true } : {}) })),
        ...(launch ? { canOpen: true } : {}),
      };
    },
    noteActive(sessions) {
      for (const { id } of sessions) if (Number.isFinite(opening.get(id))) opening.delete(id);
    },
    async open(id, reply, checkCurrent) {
      const session = typeof id === "string" && catalog.get(id);
      if (!launch || !session?.cwd) return reply(404, { error: "This saved chat is not available to open. Refresh the explorer." });
      if ((opening.get(id) ?? 0) > Date.now()) return reply(409, { error: "Pi is already opening this chat. Check Terminal or the new tab." });
      opening.set(id, Infinity);
      try {
        const peers = await presence?.list() ?? [];
        if (peers.some((peer) => peer.id === id)) {
          return reply(409, { error: "This chat is already open in another browser tab." });
        }
        if (!checkCurrent()) return;
        const outcome = await launch(session);
        if (outcome === "already-open") return reply(409, { error: "This chat already has a browser tab. Use that tab or run /chat in its Terminal." });
        opening.set(id, Date.now() + 60_000);
        return reply(202, { ok: true, attached: outcome === "attached" });
      } catch (error) {
        if (error?.status !== 404) throw error;
        catalog.delete(id);
        return reply(404, { error: error.message });
      } finally {
        if (opening.get(id) === Infinity) opening.delete(id);
      }
    },
    async cloneSession(id, reply, checkCurrent) {
      const session = typeof id === "string" && (id === current().id ? liveCloneSession : catalog.get(id));
      if (!clone || !session?.cwd) return reply(404, { error: "This chat cannot be cloned. Refresh the explorer." });
      if ((cloning.get(id) ?? 0) > Date.now()) return reply(409, { error: "Pi is already cloning this chat. Check Terminal." });
      cloning.set(id, Infinity);
      try {
        if (!checkCurrent()) return;
        await clone(session);
        cloning.set(id, Date.now() + 60_000);
        return reply(202, { ok: true });
      } catch (error) {
        if (error?.status !== 404) throw error;
        if (current().id === id) liveCloneSession = undefined;
        else catalog.delete(id);
        return reply(404, { error: error.message });
      } finally {
        if (cloning.get(id) === Infinity) cloning.delete(id);
      }
    },
    resumeCommand(id) {
      const session = catalog.get(id);
      if (!session?.cwd) return;
      return `cd -- ${shellQuote(session.cwd)} && pi --session ${shellQuote(session.path)}`;
    },
    async transcript(id) {
      const branch = await savedBranch(id);
      return branch && { messages: branch.map(renderChatEntry).filter(Boolean) };
    },
    async image(session, id, index) {
      const branch = await savedBranch(session);
      return branch && readChatImage(branch, id, index);
    },
  };
}

function chatRoutes({ noteStore, getSessionId, getSessionName, setSessionName, getBranch, isIdle, getContextUsage, getModelSettings, setModelSettings, onCompact, onSend }) {
  const rendered = new Map();
  const requests = new Map();
  let inFlight = false;
  const render = (entry) => {
    if (!rendered.has(entry.id)) rendered.set(entry.id, renderChatEntry(entry));
    return rendered.get(entry.id);
  };
  const isBusy = () => inFlight || !isIdle();
  const status = (branch?) => {
    if (isBusy()) return "working";
    const last = (branch ?? getBranch()).findLast((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role));
    return ["error", "aborted"].includes(last?.message.stopReason) ? "error" : "ready";
  };
  return {
    status,
    read(after, reply) {
      const branch = getBranch();
      const index = after === null ? -1 : branch.findIndex((entry) => entry.id === after);
      if (after !== null && index < 0) {
        reply(410, { error: "The Pi branch changed. Run /chat again." });
        return;
      }
      const messages = branch.slice(index + 1).map(render).filter(Boolean);
      const state = status(branch);
      reply(200, { mode: "chat", protocol: 2, annotationImages: true, sessionId: getSessionId?.(), sessionName: getSessionName?.(), cursor: branch.at(-1)?.id ?? null, messages, busy: state === "working", failed: state === "error", contextUsage: getContextUsage?.(), canCompact: typeof onCompact === "function" && branch.some((entry) => entry.type === "message" && entry.message.role === "user") });
    },
    async modelSettings(reply, checkCurrent, change?) {
      if (!getModelSettings || (change && !setModelSettings)) {
        reply(501, { error: "Model settings are unavailable for this chat." });
        return;
      }
      if (change) {
        if (isBusy()) {
          reply(409, { error: "Pi is busy. Wait for it to finish and retry." });
          return;
        }
        inFlight = true;
      }
      try {
        if (change) await setModelSettings(change);
        if (!checkCurrent()) return;
        const settings = await getModelSettings();
        if (checkCurrent()) reply(200, settings);
      } finally {
        if (change) inFlight = false;
      }
    },
    async compact(reply) {
      if (typeof onCompact !== "function") {
        reply(501, { error: "Compaction is unavailable for this chat." });
        return false;
      }
      if (isBusy()) {
        reply(409, { error: "Pi is busy. Wait for it to finish and retry." });
        return false;
      }
      inFlight = true;
      try {
        await onCompact();
        return true;
      } finally {
        inFlight = false;
      }
    },
    image(id, index) {
      return readChatImage(getBranch(), id, index);
    },
    async readNote() {
      const sessionId = getSessionId?.();
      if (!noteStore || typeof sessionId !== "string" || !sessionId) throw new Error("Persistent note storage is unavailable.");
      return noteStore.read(sessionId);
    },
    async saveNote(markdown) {
      const sessionId = getSessionId?.();
      if (!noteStore || typeof sessionId !== "string" || !sessionId) throw new Error("Persistent note storage is unavailable.");
      await noteStore.write(sessionId, markdown);
    },
    rename(name, reply) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error("Choose a chat name between 1 and 100 characters without control characters.");
      }
      if (typeof setSessionName !== "function") {
        reply(501, { error: "Renaming this session is unavailable." });
        return;
      }
      const sessionName = name.trim();
      setSessionName(sessionName);
      reply(200, { sessionName: getSessionName?.() ?? sessionName });
    },
    async send(body, reply) {
      const { requestId, text, attachments, annotations } = body;
      if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId) ||
          (text === undefined) === (annotations === undefined) || (annotations !== undefined && attachments !== undefined)) {
        throw new Error("Invalid chat submission.");
      }
      const fingerprint = createHash("sha256").update(JSON.stringify([text, attachments, annotations])).digest("hex");
      let attempt = requests.get(requestId);
      if (attempt && attempt.fingerprint !== fingerprint) {
        reply(409, { error: "A send already used this request ID." });
        return;
      }
      if (!attempt) {
        if (isBusy()) {
          reply(409, { error: "Pi is busy. Wait for it to finish and retry." });
          return;
        }
        let prompt;
        if (annotations !== undefined) {
          const entries = new Map(getBranch().map((entry) => [entry.id, entry]));
          prompt = formatChatAnnotations(annotations, (id) => {
            const entry = entries.get(id);
            const message = entry && render(entry);
            return message?.role === "assistant" ? message.text : undefined;
          }, annotationImagesAt(annotations));
        } else {
          if (typeof text !== "string" || (!text.trim() && attachments === undefined) || text.length > 32000) {
            throw new Error("Write a message (up to 32,000 characters) or attach files.");
          }
          const caption = text.trim();
          prompt = attachments === undefined ? caption : [...(caption ? [{ type: "text", text: caption }] : []), ...attachmentBlocks(attachments)];
        }
        const completion = onSend(prompt).then(() => { inFlight = false; }, (error) => {
          inFlight = false;
          requests.delete(requestId);
          throw error;
        });
        inFlight = true;
        attempt = { fingerprint, completion };
        requests.set(requestId, attempt);
      }
      // Pi's public send API is fire-and-forget. Keep the request ID reserved even
      // if confirmation is late, so a retry can't dispatch a second turn.
      let timeout;
      try {
        const confirmed = await Promise.race([attempt.completion.then(() => true), new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), 15000);
          timeout.unref();
        })]);
        if (confirmed) reply(200, { ok: true });
        else reply(504, { error: "Pi hasn't confirmed this send. Check the terminal. Retrying the same send only checks for confirmation." });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Loopback only; no direct model calls, session-file writes, cookies, or CORS. */
export async function startChatServer({ chat, onClose, isCurrent = () => true, ttlMs = 30 * 60_000 }) {
  const live = chatRoutes(chat);
  const presence = chat.presence;
  const explorer = chat.explorer && explorerRoutes(chat.explorer, presence);
  const reopenCommand = "/chat";
  const token = randomBytes(32).toString("hex");
  const landing = `/?tab=${randomBytes(16).toString("hex")}`;
  let origin;
  let activityTimer;
  let expired = false;
  const publishActivity = (heartbeat) => presence?.touch?.(ttlMs, { status: live.status(), tab: origin + landing }, heartbeat);
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== new URL(origin).host ||
          (req.headers.origin && req.headers.origin !== origin) ||
          req.headers["sec-fetch-site"] === "cross-site") {
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
        if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
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
