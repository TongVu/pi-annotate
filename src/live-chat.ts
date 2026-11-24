import { createHash } from "node:crypto";
import { formatChatAnnotations } from "./annotations.ts";
import { annotationImagesAt, attachmentBlocks } from "./chat-attachments.ts";
import { renderChatEntry, readChatImage } from "./chat-transcript.ts";

export function createLiveChat({ noteStore, getSessionId, getSessionName, setSessionName, getBranch, isIdle, getContextUsage, getModelSettings, setModelSettings, onCompact, onSend }) {
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
  function noteSessionId() {
    const sessionId = getSessionId?.();
    if (!noteStore || typeof sessionId !== "string" || !sessionId) throw new Error("Persistent note storage is unavailable.");
    return sessionId;
  }
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
      const sessionId = noteSessionId();
      const [markdown, attachments] = await Promise.all([noteStore.read(sessionId), noteStore.readAttachments(sessionId)]);
      return { markdown, attachments };
    },
    saveNote(markdown) {
      return noteStore.write(noteSessionId(), markdown);
    },
    saveNoteAttachments(attachments) {
      return noteStore.writeAttachments(noteSessionId(), attachments);
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
