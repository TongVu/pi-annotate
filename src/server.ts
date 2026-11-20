import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateAnnotations, formatAnnotations, formatChatAnnotations, visibleChatMessage } from "./annotations.ts";
import { renderMarkdown } from "./markdown.ts";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const BODY_LIMIT = 512 * 1024;
const MAX_ATTACHMENTS = 10;
const FILE_LIMIT = 5 * 1024 * 1024;
const ATTACHMENTS_LIMIT = 10 * 1024 * 1024;
const TEXT_FILES_LIMIT = 128 * 1024;
const FILE_BASE64_LIMIT = Math.ceil(FILE_LIMIT / 3) * 4;
const CHAT_BODY_LIMIT = BODY_LIMIT + Math.ceil(ATTACHMENTS_LIMIT / 3) * 4 + MAX_ATTACHMENTS * 4;
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

function attachmentBlocks(files) {
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

function chatRoutes({ getBranch, isIdle, onSend }) {
  const rendered = new Map();
  const requests = new Map();
  let inFlight = false;
  const render = (entry) => {
    if (!rendered.has(entry.id)) {
      const message = visibleChatMessage(entry);
      rendered.set(entry.id, message?.role === "assistant" ? { ...message, ...renderMarkdown(message.text) } : message);
    }
    return rendered.get(entry.id);
  };
  return {
    read(after, reply) {
      const branch = getBranch();
      const index = after === null ? -1 : branch.findIndex((entry) => entry.id === after);
      if (after !== null && index < 0) {
        reply(410, { error: "The Pi branch changed. Run /chat again." });
        return;
      }
      const messages = branch.slice(index + 1).map(render).filter(Boolean);
      const busy = inFlight || !isIdle();
      const last = branch.findLast((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role));
      const failed = !busy && ["error", "aborted"].includes(last?.message.stopReason);
      reply(200, { mode: "chat", protocol: 2, cursor: branch.at(-1)?.id ?? null, messages, busy, failed });
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
        if (inFlight || !isIdle()) {
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
          });
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
export async function startAnnotationServer({ response, onSubmit, chat, onClose, isCurrent = () => true, ttlMs = 30 * 60_000 }) {
  const renderedResponse = response && { id: response.id, ...renderMarkdown(response.text) };
  const live = chat && chatRoutes(chat);
  const reopenCommand = live ? "/chat" : "/annotate";
  const token = randomBytes(32).toString("hex");
  let origin;
  let accepted;
  let expired = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== new URL(origin).host ||
          (req.headers.origin && req.headers.origin !== origin) ||
          req.headers["sec-fetch-site"] === "cross-site") {
        reply(403, { error: "Only this local annotation page may connect." });
        return;
      }
      if (expired || !isCurrent()) {
        reply(410, { error: `This browser page expired or its Pi session/branch changed. Run ${reopenCommand} again.` });
        return;
      }
      if (req.method === "GET" && assets[req.url]) {
        const [file, type] = assets[req.url];
        const data = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(401, { error: "Missing or invalid annotation token. Reopen from Pi." });
        return;
      }
      const url = new URL(req.url, origin);
      if (req.method === "GET" && url.pathname === "/api/response") {
        if (live) {
          timer.refresh(); // An authenticated poll keeps a chat alive; draft windows still have a fixed lifetime.
          live.read(url.searchParams.get("after"), reply);
        } else reply(200, { response: renderedResponse, submitted: accepted !== undefined });
        return;
      }
      const disconnect = live && req.url === "/api/close";
      if (req.method === "POST" && (disconnect || req.url === (live ? "/api/chat" : "/api/annotations"))) {
        if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
          reply(403, { error: "Expected a same-origin JSON request." });
          return;
        }
        if (disconnect) {
          res.once("finish", close);
          reply(200, { ok: true });
          return;
        }
        const raw = await readBody(req, live ? CHAT_BODY_LIMIT : BODY_LIMIT);
        const body = JSON.parse(raw.toString("utf8"));
        if (raw.length > BODY_LIMIT && body?.attachments === undefined) throw new Error("Request is too large.");
        // Check again after awaiting the request body; Pi may have changed sessions.
        if (expired || !isCurrent()) {
          reply(410, { error: `Pi session/branch changed. Run ${reopenCommand} again.` });
          return;
        }
        if (live) {
          await live.send(body, reply);
          return;
        }
        const items = validateAnnotations(body.annotations, renderedResponse.text);
        const formatted = formatAnnotations(response.id, items);
        if (accepted !== undefined && accepted !== formatted) {
          reply(409, { error: "Already added to Pi. Run /annotate for another batch." });
          return;
        }
        if (accepted === undefined) {
          // Synchronous callback: check idle state and append to the *current* draft atomically.
          onSubmit(formatted);
          accepted = formatted;
        }
        reply(200, { ok: true });
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
    server.close();
    server.closeAllConnections();
    onClose?.();
  };
  const timer = setTimeout(close, ttlMs);
  timer.unref();
  return { url: `${origin}/#${token}`, close };
}
