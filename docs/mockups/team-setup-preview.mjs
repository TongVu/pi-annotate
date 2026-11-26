// Run from the repository root: node docs/mockups/team-setup-preview.mjs
// Preview the real page and team API without credentials, model calls, or Git changes.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentTeam } from "../../src/agent-team.ts";
import { saveChatAttachments } from "../../src/chat-attachments.ts";
import { teamReportType } from "../../src/chat-transcript.ts";
import { startChatServer } from "../../src/server.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-chat-team-preview-"));
const branch = [{ id: "preview-intro", type: "message", message: { role: "assistant", content:
  "**Teams preview · simulated workers.** Click **Teams**, add a brief and files, and click **Start team**. The real Pi Chat page and API handle the drafts and attachments. This preview does not call a model or change a Git checkout." } }];
const team = createAgentTeam({
  prepare: async () => ({ head: "demo", backend: "(simulated backend worktree)", frontend: "(simulated frontend worktree)" }),
  saveAttachments: (items) => saveChatAttachments(scratch, "preview", items),
  openWorker: async () => {
    let listener, inputs;
    const controller = new AbortController();
    const abort = async () => { controller.abort(); };
    return {
      subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
      abort,
      dispose: () => { void abort(); },
      async prompt(text, { images = [] } = {}) {
        inputs ??= { files: (text.match(/^(?:--- )?Attached file:/gm) ?? []).length, images: images.length };
        const role = text.match(/^You are the (.+?) in a Pi Chat team\./)?.[1] ?? "Role";
        const evidence = `Received ${inputs.files} text file(s) and ${inputs.images} image(s).`;
        await delay(750, undefined, { signal: controller.signal });
        const report = text.includes("Your final report appears in the main chat")
          ? `The simulated team completed its handoffs. ${evidence} This preview made no model requests, edits, or merges.`
          : `${role}: ${evidence} Simulated assignment complete.`;
        listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "done", report }) }] } });
      },
    };
  },
  onComplete: ({ review }) => branch.push({ id: randomUUID(), type: "custom_message", customType: teamReportType, display: true, content: review }),
});
const cleanup = () => { void rm(scratch, { recursive: true, force: true }); };
const server = await startChatServer({
  ttlMs: 8 * 60 * 60_000,
  onClose: cleanup,
  chat: {
    team,
    getBranch: () => branch,
    isIdle: () => true,
    getSessionName: () => "Teams preview",
    getSessionId: () => "preview",
    noteStore: { read: async () => "", readAttachments: async () => [], write: async () => {} },
  },
});
process.once("SIGINT", server.close);
process.once("SIGTERM", server.close);
console.log(server.url);
