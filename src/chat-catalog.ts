import { resolve } from "node:path";
import { renderChatEntry, readChatImage } from "./chat-transcript.ts";
import { shellQuote } from "./resume-chat.ts";

export function createChatCatalog({ current, list, read, launch, clone }, presence) {
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
