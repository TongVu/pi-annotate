// Run from the repository root: node docs/mockups/team-setup-preview.mjs
// Exercise the real page, team runner, and Git diff with offline workers in a temporary repo.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentTeam, prepareTeamWorkspace } from "../../src/agent-team.ts";
import { saveChatAttachments } from "../../src/chat-attachments.ts";
import { startChatServer } from "../../src/server.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-chat-team-preview-"));
const repo = join(scratch, "fixture");
await mkdir(repo);
const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { stdio: "pipe" });
git("init");
await writeFile(join(repo, "api.js"), 'export const status = { label: "Not started", round: 0 };\n');
git("add", "api.js");
git("-c", "user.name=Preview", "-c", "user.email=preview@example.invalid", "commit", "-m", "chore: seed preview fixture");
const branch = [];
const addMessage = (role, content) => branch.push({ id: `preview-${branch.length + 1}`, type: "message", message: { role, content } });
addMessage("assistant", "**Teams preview · simulated workers.** Open **Teams** in the Main chat composer. Send one requirement and you’ll return here automatically. The roster stays on the right; **Context** shows the brief. No model requests or changes to your repository.");
const team = createAgentTeam({
  captureBlocker: () => () => { addMessage("assistant", "The simulated team needs a decision. In the live app, I would ask for it here in Main chat."); return true; },
  captureHandoff: () => () => { addMessage("assistant", "The simulated team finished. **View team result** in the sidebar to inspect the combined changes. Main chat stays open until you choose to inspect them."); return true; },
  modelChoices: [
    { key: "openai/gpt-6.2-astra", label: "GPT-6.2 Astra (openai)", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { key: "openai/gpt-6.2-sol", label: "GPT-6.2 Sol (openai)", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { key: "openai/gpt-6-luna", label: "GPT-6 Luna (openai)", efforts: ["low", "medium", "high", "xhigh"] },
  ],
  prepare: async ({ workspace }) => workspace ?? prepareTeamWorkspace(repo, scratch),
  saveAttachments: (items) => saveChatAttachments(scratch, "preview", items),
  openWorker: async ({ cwd, writable }) => {
    let listener, round = 0;
    const controller = new AbortController();
    const abort = async () => { controller.abort(); };
    return {
      subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
      abort,
      dispose: () => { void abort(); },
      async prompt(text, { images = [] } = {}) {
        const role = text.match(/^You are the (.+?) in a Pi Chat team\./)?.[1] ?? "Role";
        const files = (text.match(/^(?:--- )?Attached file:/gm) ?? []).length;
        await delay(600, undefined, { signal: controller.signal });
        if (writable && role === "Backend implementer") {
          round++;
          await writeFile(join(cwd, "api.js"), `export const status = { label: "Ready", round: ${round} };\n`);
        }
        if (writable && role === "Frontend implementer") {
          const api = await readFile(join(cwd, "api.js"), "utf8");
          const currentRound = api.match(/round: (\d+)/)?.[1];
          await writeFile(join(cwd, "view.js"), `import { status } from "./api.js";\n\n// Updated after reading the backend in round ${currentRound}.\nexport const renderStatus = () => \`\${status.label} · round \${status.round}\`;\n`);
        }
        const report = `${role}: simulated handoff. Received ${files} text file(s) and ${images.length} image(s) this turn.`;
        listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: "done", report }) }] } });
      },
    };
  },
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
    onSend: (prompt) => {
      addMessage("user", prompt);
      addMessage("assistant", "This message stayed in Main chat. This offline preview doesn’t contact Pi or the team.");
    },
    noteStore: { read: async () => "", readAttachments: async () => [], write: async () => {} },
  },
});
process.once("SIGINT", server.close);
process.once("SIGTERM", server.close);
console.log(server.url);
