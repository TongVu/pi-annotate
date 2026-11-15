import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateAnnotations, formatAnnotations } from "./annotations.ts";
import { renderMarkdown } from "./markdown.ts";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const BODY_LIMIT = 512 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("Annotations are too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request cancelled.")));
  });
}

/** No model calls, session-file writes, cookies, CORS, or non-loopback listeners. */
export async function startAnnotationServer({ response, onSubmit, isCurrent = () => true, ttlMs = 30 * 60_000 }) {
  const renderedResponse = { id: response.id, ...renderMarkdown(response.text) };
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
        reply(410, { error: "This annotation window expired or its Pi session/branch changed. Run /annotate again." });
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
      if (req.method === "GET" && req.url === "/api/response") {
        reply(200, { response: renderedResponse, submitted: accepted !== undefined });
        return;
      }
      if (req.method === "POST" && req.url === "/api/annotations") {
        if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
          reply(403, { error: "Expected a same-origin JSON request." });
          return;
        }
        const body = JSON.parse(await readBody(req));
        const items = validateAnnotations(body.annotations, renderedResponse.text);
        const formatted = formatAnnotations(response.id, items);
        // Check again after awaiting the request body; Pi may have changed sessions.
        if (expired || !isCurrent()) {
          reply(410, { error: "Pi session/branch changed. Run /annotate again." });
          return;
        }
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
    expired = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(close, ttlMs);
  timer.unref();
  return { url: `${origin}/#${token}`, close };
}
