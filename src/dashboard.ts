import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { listLiveChats } from "./chat-presence.ts";
import { readCodexQuota, type CodexQuota } from "./codex-quota.ts";
import { canFocusBrowser, focusBrowserChat } from "./focus-browser.ts";
import { isLocalRequest, isSameOriginJson, setLocalPageHeaders } from "./loopback-http.ts";
import { shellQuote } from "./resume-chat.ts";
import { listOwnedSessions, requestOwnedChat } from "./session-owner.ts";
import { readWebAsset } from "./web-assets.ts";

const assets = new Map([
  ["/", ["dashboard.html", "text/html; charset=utf-8"]],
  ["/dashboard.css", ["dashboard.css", "text/css; charset=utf-8", "tooltips.css"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8", "tooltips.js"]],
  ["/favicon.ico", ["favicon.ico", "image/x-icon"]],
  ["/logo.png", ["logo.png", "image/png"]],
]);

type SavedChat = Pick<SessionInfo, "id" | "cwd" | "path" | "name" | "firstMessage" | "modified" | "parentSessionPath">;
type Options = {
  list: () => Promise<SavedChat[]>;
  presenceDir: string;
  ownerDir: string;
  bookmarkDir: string;
  tabRegistry?: string;
  project?: string;
  resume?: (session: SavedChat) => Promise<void | false>;
  verifyChat?: (cwd: string, name?: string) => Promise<void>;
  createChat?: (cwd: string) => Promise<void | false>;
  canFocus?: typeof canFocusBrowser;
  focus?: typeof focusBrowserChat;
  focusTerminal?: () => Promise<void>;
  readQuota?: typeof readCodexQuota;
};

// One marker per ID keeps updates to different sessions independent across dashboards.
const bookmarkKey = (id: string) => createHash("sha256").update(id).digest("hex");

export async function listDashboardTabs(registry: string) {
  const tabs: string[] = [];
  for (const name of await readdir(registry).catch(() => [])) {
    const match = /^([1-9]\d*)-([1-9]\d{0,4})-([a-f0-9]{32})$/.exec(name);
    if (!match) continue;
    const [, pid, port, id] = match;
    try { process.kill(Number(pid), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") await rm(join(registry, name), { force: true }).catch(() => {});
      continue;
    }
    tabs.push(`http://127.0.0.1:${port}/?dashboard=${id}`);
  }
  return tabs;
}

export async function startDashboard({ list, presenceDir, ownerDir, bookmarkDir, tabRegistry, project, resume, createChat, verifyChat, canFocus = canFocusBrowser, focus = focusBrowserChat, focusTerminal, readQuota = readCodexQuota }: Options) {
  const token = randomBytes(32).toString("hex");
  const tabId = randomBytes(16).toString("hex");
  const tabPath = `/?dashboard=${tabId}`;
  let origin: string;
  let closed = false;
  let listing: Promise<SavedChat[]> | undefined;
  let listAgain = 0;
  const opening = new Map<string, number>();
  const verifying = new Set<string>();
  let creating = false;
  let codexQuota: CodexQuota | undefined;
  let nextQuotaRead = 0;
  function refreshQuota() {
    if (Date.now() < nextQuotaRead) return;
    nextQuotaRead = Infinity;
    // The session list should not wait for a subprocess or a network call.
    void Promise.resolve().then(readQuota).catch(() => undefined).then((quota) => {
      codexQuota = quota;
      nextQuotaRead = Date.now() + 60_000;
    });
  }
  async function discover(refresh = false) {
    // Pi's session index may read every session file. Poll the lightweight live markers more often.
    if (!listing || Date.now() >= listAgain || (refresh && listAgain !== Infinity)) {
      listAgain = Infinity;
      listing = list().finally(() => { listAgain = Date.now() + 10_000; });
    }
    const [sessions, peers, owners] = await Promise.all([listing, listLiveChats(presenceDir), listOwnedSessions(ownerDir)]);
    // The startup guard is only needed until Pi registers. Its browser tab can then be closed and reopened immediately.
    for (const { id } of owners) if (Number.isFinite(opening.get(id))) opening.delete(id);
    // The launch directory is a project even before its first session exists.
    const projects = new Set([project, ...[...sessions, ...peers, ...owners].map(({ cwd }) => cwd)]
      .filter((cwd): cwd is string => typeof cwd === "string" && isAbsolute(cwd)));
    return {
      projects,
      saved: new Map(sessions.map((session) => [session.id, session])),
      live: new Map(peers.map((session) => [session.id, session])),
      owned: new Map(owners.map((session) => [session.id, session])),
    };
  }
  const server = createServer(async (req, res) => {
    setLocalPageHeaders(res);
    const reply = (status: number, body: unknown) => {
      if (closed || res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
    };
    try {
      if (!isLocalRequest(req.headers, origin)) {
        return reply(403, { error: "Only this local dashboard may connect." });
      }
      const asset = req.method === "GET" && assets.get(req.url === tabPath ? "/" : req.url ?? "");
      if (asset) {
        const [file, type, prefix] = asset;
        const data = await readWebAsset(file, prefix);
        res.writeHead(200, { "Content-Type": type }).end(data);
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "Reopen the dashboard from Pi." });
      const agent = req.headers["user-agent"] ?? "";
      const browserSwitcher = process.platform === "linux" && /(?:Chrome|Edg)\//.test(agent);
      if (req.method === "GET" && ["/api/dashboard", "/api/dashboard?refresh=1"].includes(req.url ?? "")) {
        refreshQuota();
        const [{ saved, live, owned, projects }, markers] = await Promise.all([
          discover(req.url.endsWith("?refresh=1")),
          readdir(bookmarkDir).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          }),
        ]);
        const bookmarks = new Set(markers);
        const ids = new Set([...saved.keys(), ...live.keys(), ...owned.keys()]);
        const idsByPath = new Map([...saved.values()].map(({ path, id }) => [resolve(path), id]));
        const sessions = [...ids].map((id) => {
          const peer = live.get(id);
          const owner = owned.get(id);
          const session = saved.get(id);
          const parentId = session?.parentSessionPath ? idsByPath.get(resolve(session.parentSessionPath)) : undefined;
          const preview = session?.firstMessage?.replace(/\s+/g, " ").trim().slice(0, 180) || "";
          const name = peer?.name?.trim() || session?.name?.trim() || owner?.name?.trim() || preview.slice(0, 100) || "Untitled session";
          return {
            id, name, cwd: peer?.cwd || owner?.cwd || session?.cwd || "",
            parentId: parentId !== id ? parentId : undefined,
            preview: preview !== name ? preview : "",
            modified: session?.modified.getTime() ?? null,
            bookmarked: bookmarks.size > 0 && bookmarks.has(bookmarkKey(id)),
            status: peer ? peer.status ?? "connected" : owner ? "disconnected" : "saved",
            terminalWorking: !peer && owner?.working ? true : undefined,
            canVerify: verifyChat && (peer?.cwd || owner?.cwd || session?.cwd) ? true : undefined,
            action: peer ? (peer.tab && canFocus(agent) ? "focus" : peer.tab && browserSwitcher ? "browser-tab" : "manual-tab")
              : owner ? "reopen" : session?.cwd ? (resume ? "resume" : "manual-resume") : "unavailable",
          };
        });
        return reply(200, { projects: [...projects].sort(), sessions, supportsBookmarks: true, browserSelect: browserSwitcher || undefined, canFocusTerminal: focusTerminal ? true : undefined, codexQuotaLeft: codexQuota?.left, codexQuotaResetsAt: codexQuota?.resetsAt });
      }
      const newChat = req.url === "/api/session/new";
      const verify = req.url === "/api/session/verify";
      const focusHost = req.url === "/api/focus-terminal";
      const bookmark = req.url === "/api/session/bookmark";
      if (req.method === "POST" && (newChat || verify || focusHost || bookmark || req.url === "/api/open")) {
        if (!isSameOriginJson(req.headers, origin)) {
          return reply(403, { error: "Expected a same-origin JSON request." });
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 4096) return reply(413, { error: "Request is too large." });
        }
        const body = JSON.parse(raw);
        if (bookmark) {
          const { id, bookmarked } = body ?? {};
          if (typeof id !== "string" || !id || typeof bookmarked !== "boolean" || Object.keys(body).length !== 2) {
            return reply(400, { error: "Select a session and bookmark state from the dashboard." });
          }
          const { saved, live, owned } = await discover();
          if (closed) return;
          if (!saved.has(id) && !live.has(id) && !owned.has(id)) return reply(404, { error: "That session is no longer on the dashboard." });
          const marker = join(bookmarkDir, bookmarkKey(id));
          if (bookmarked) {
            await mkdir(bookmarkDir, { recursive: true, mode: 0o700 });
            await writeFile(marker, "", { mode: 0o600 });
          } else await rm(marker, { force: true });
          return reply(200, { bookmarked });
        }
        if (focusHost) {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
            return reply(400, { error: "Switch to Terminal does not accept a target." });
          }
          if (!focusTerminal) return reply(501, { error: "Switch to Terminal is unavailable for this dashboard." });
          if (closed) return;
          await focusTerminal();
          return reply(200, { message: "Switched to the terminal hosting this dashboard." });
        }
        if (verify) {
          const id = body?.id;
          if (typeof id !== "string" || !id || Object.keys(body).length !== 1) return reply(400, { error: "Choose a session to verify." });
          if (!verifyChat) return reply(501, { error: "Reviewer launch is unavailable on this dashboard." });
          if (verifying.has(id)) return reply(409, { error: "Already starting this reviewer." });
          verifying.add(id);
          try {
            const { saved, live, owned } = await discover(true);
            const cwd = live.get(id)?.cwd || owned.get(id)?.cwd || saved.get(id)?.cwd;
            if (!cwd || !isAbsolute(cwd)) return reply(404, { error: "This session’s worktree is unavailable." });
            if (closed) return;
            await verifyChat(cwd, live.get(id)?.name || saved.get(id)?.name || owned.get(id)?.name);
            return reply(202, { message: "Starting an independent reviewer. A new chat tab will open when Pi is ready." });
          } finally { verifying.delete(id); }
        }
        if (newChat) {
          const cwd = body?.cwd;
          if (typeof cwd !== "string" || !isAbsolute(cwd) || Object.keys(body).length !== 1) {
            return reply(400, { error: "Choose a project from the dashboard." });
          }
          const { projects } = await discover(true);
          if (closed) return;
          if (!projects.has(cwd)) {
            return reply(404, { error: "That project is no longer on the dashboard. Refresh and choose another project." });
          }
          if (creating) return reply(409, { error: "Pi is already opening a new chat. Check Terminal or the new tab." });
          creating = true;
          try {
            if (!createChat || await createChat(cwd) === false) {
              const command = process.platform === "win32"
                ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}' -ErrorAction Stop; if ($?) { pi }`
                : `cd -- ${shellQuote(cwd)} && pi`;
              return reply(200, {
                command,
                message: createChat ? "Kitty did not accept the tab launch. Check launch permission or use the manual command." : undefined,
              });
            }
            return reply(202, { message: "Starting a new Pi session in Terminal. A chat tab will open when Pi is ready." });
          } finally {
            creating = false;
          }
        }
        if (typeof body?.id !== "string" || !["focus", "open", "select"].includes(body?.intent) || Object.keys(body).length !== 2) {
          return reply(400, { error: "Select a session from the dashboard." });
        }
        const { id, intent } = body;
        const { live, saved, owned } = await discover();
        if (closed) return;
        const peer = live.get(id);
        if (intent !== "select" && !!peer !== (intent === "focus")) {
          return reply(409, { error: "That chat’s connection changed. Check its updated status and try again." });
        }
        if (peer) {
          if (peer.tab && intent === "select" && browserSwitcher) return reply(200, { focusTab: peer.tab });
          if (peer.tab && canFocus(agent) && await focus(peer.tab, agent)) return reply(200, { message: "Switched to the existing chat tab." });
          return reply(409, { error: "Could not switch to the connected tab. Select the existing tab manually; no duplicate was opened." });
        }
        const session = saved.get(id);
        if (!session?.cwd && !owned.has(id)) return reply(404, { error: "This session is no longer available to open." });
        if ((opening.get(id) ?? 0) > Date.now()) return reply(409, { error: "Pi is already opening this chat. Check Terminal or the new tab." });
        opening.set(id, Infinity);
        try {
          const outcome = await requestOwnedChat(ownerDir, id);
          if (closed) return;
          if (outcome === "attached") return reply(202, { message: "Opening a tab from the running Pi session." });
          if (outcome === "already-open") return reply(409, { error: "Pi already has a browser link for this session. Use the existing tab or run /chat in its terminal." });
          if (outcome === "suspended") return reply(409, { error: "Pi is suspended in its terminal. Use jobs to find the Pi job, bring it to the foreground with fg, then click again. No second Pi was started." });
          if (outcome === "unavailable") return reply(409, { error: "Could not reach the running Pi session. Run /chat in its terminal; no second Pi was started." });
          if (!session?.cwd) return reply(404, { error: "This session is no longer running and has no saved chat to resume." });
          if (!resume || await resume(session) === false) return reply(200, {
            command: `cd -- ${shellQuote(session.cwd)} && pi --session ${shellQuote(session.path)}`,
            message: resume ? "Kitty did not accept the tab launch. Check launch permission or use the manual command." : undefined,
          });
          const deadline = Date.now() + 60_000;
          opening.set(id, deadline);
          setTimeout(() => { if (opening.get(id) === deadline) opening.delete(id); }, 60_000).unref();
          return reply(202, { message: "Resuming in Terminal. The chat tab will open when Pi is ready." });
        } finally {
          if (opening.get(id) === Infinity) opening.delete(id);
        }
      }
      reply(404, { error: "Not found." });
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : "Dashboard request failed." });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as import("node:net").AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  // Publish only the tab locator, never the dashboard's bearer token.
  const marker = tabRegistry && join(tabRegistry, `${process.pid}-${port}-${tabId}`);
  if (tabRegistry && marker) {
    await mkdir(tabRegistry, { recursive: true, mode: 0o700 })
      .then(() => writeFile(marker, "", { mode: 0o600 })).catch(() => {});
  }
  return {
    url: `${origin}${tabPath}#${token}`,
    async close() {
      if (closed) return;
      closed = true;
      server.close();
      server.closeAllConnections();
      if (marker) await rm(marker, { force: true }).catch(() => {});
    },
  };
}
