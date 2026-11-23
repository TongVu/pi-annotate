import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startChatServer } from "./server.ts";
import { createChatNoteStore } from "./chat-notes.ts";
import { listPiSessions, readPiSession } from "./session-explorer.ts";
import { createChatPresence } from "./chat-presence.ts";
import { AUTO_CHAT_SESSION, forkChatInTerminal, resumeChatInTerminal } from "./resume-chat.ts";
import { registerSessionOwner, requestOwnedChat } from "./session-owner.ts";

// Keep the existing registry names so running Pi processes can still discover each other.
async function ownerRegistry() {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return join(getAgentDir(), "pi-annotate-owners");
}

function openPage(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Browser launcher exited with ${code}`)));
  });
}

export default function piChat(pi: ExtensionAPI) {
  registerChatExtension(pi, openPage);
}

export function registerChatExtension(pi: ExtensionAPI, launchPage: (url: string) => Promise<void>) {
  let active: Awaited<ReturnType<typeof startChatServer>> | undefined;
  let closeOwner: (() => Promise<void>) | undefined;
  let ownerGeneration = 0;
  let generation = 0;
  const chatDispatch = new AsyncLocalStorage<() => void>();
  pi.on("message_end", (event) => {
    // This callback belongs to the async Pi run started by this browser send,
    // not a concurrent terminal prompt. A transformed input is still accepted.
    if (event.message.role === "user") chatDispatch.getStore()?.();
  });
  const stop = () => {
    generation++;
    active?.close();
    active = undefined;
  };
  pi.on("session_shutdown", async () => {
    stop();
    ownerGeneration++;
    const close = closeOwner;
    closeOwner = undefined;
    await close?.();
  });
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);

  const runChatPage = async (args: string, ctx: ExtensionContext, commandContext?: ExtensionCommandContext) => {
    const mode = args.trim();
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/chat requires Pi's terminal UI.", "warning");
      return;
    }
    if (mode === "close") {
      stop();
      ctx.ui.notify("Browser page disconnected.", "info");
      return;
    }
    if (mode && mode !== "link") {
      ctx.ui.notify("Usage: /chat [link | close]", "warning");
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    stop();
    const currentGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const chatIdentity = () => ({ id: sessionId, cwd: ctx.sessionManager.getCwd(), path: ctx.sessionManager.getSessionFile(), name: ctx.sessionManager.getSessionName() });
    const anchor = branch.at(-1)?.id;
    const isCurrent = () => generation === currentGeneration &&
      ctx.sessionManager.getSessionId() === sessionId &&
      (anchor === undefined || ctx.sessionManager.getBranch().some((entry) => entry.id === anchor));
    try {
      // Keep the existing path so the repository rename doesn't strand saved notes.
      const noteStore = createChatNoteStore(join(ctx.sessionManager.getSessionDir(), ".pi-annotate-notes"));
      const opened = await startChatServer({
        isCurrent,
        onClose: () => {
          if (generation === currentGeneration) {
            generation++;
            active = undefined;
          }
        },
        chat: {
          noteStore,
          getSessionId: () => ctx.sessionManager.getSessionId(),
          getSessionName: () => ctx.sessionManager.getSessionName(),
          setSessionName: (sessionName: string) => pi.setSessionName(sessionName),
          presence: createChatPresence(async () => {
            const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
            return join(getAgentDir(), "pi-annotate-live");
          }, () => {
            const { id, cwd, name } = chatIdentity();
            return { id, cwd, name };
          }),
          explorer: {
            current: chatIdentity,
            ...(commandContext ? { createNewSession: async () => {
              try {
                const result = await commandContext.newSession({
                  withSession: async (newContext) => { await runChatPage("", newContext, newContext); },
                });
                if (result.cancelled && ctx.sessionManager.getSessionId() === sessionId) ctx.ui.notify("New chat cancelled.", "info");
              } catch (error) {
                if (ctx.sessionManager.getSessionId() === sessionId) ctx.ui.notify(`Could not start a new chat: ${error instanceof Error ? error.message : String(error)}`, "error");
              }
            } } : {}),
            list: () => listPiSessions(ctx.sessionManager.getSessionDir()),
            read: readPiSession,
            ...(process.platform === "darwin" ? {
              launch: async (session) => {
                const outcome = await requestOwnedChat(await ownerRegistry(), session.id);
                if (outcome === "attached" || outcome === "already-open") return outcome;
                if (outcome === "unavailable") throw new Error("This session is open in Pi but could not open a browser tab. Run /chat in its Terminal; no second Pi was started.");
                const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
                await resumeChatInTerminal(session, fileURLToPath(import.meta.url), getAgentDir());
                return "launched";
              },
              clone: async (session) => {
                const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
                await forkChatInTerminal(session, fileURLToPath(import.meta.url), getAgentDir());
              },
            } : {}),
          },
          getBranch: () => ctx.sessionManager.getBranch(),
          isIdle: () => ctx.isIdle(),
          onSend: (content: Parameters<ExtensionAPI["sendUserMessage"]>[0]) => new Promise<void>((resolve) => {
            if (Array.isArray(content) && content.some((block) => block.type === "image")) {
              if (pi.getSettings().images?.blockImages) throw new Error("Images are disabled in Pi's settings.");
              if (!ctx.model?.input.includes("image")) throw new Error("The current Pi model cannot receive images. Choose an image-capable model in Pi.");
            }
            chatDispatch.run(resolve, () => pi.sendUserMessage(content, { expandPromptTemplates: false }));
          }),
        },
      });
      if (!isCurrent()) {
        opened.close();
        return;
      }
      active = opened;
      ctx.ui.notify(`Local chat (stays open while the tab is connected): ${active.url}`, "info");
      if (mode !== "link") {
        try {
          await launchPage(opened.url);
        } catch {
          if (isCurrent()) ctx.ui.notify("Could not open a browser. Open the local link above manually.", "warning");
          return false;
        }
      }
      return true;
    } catch (error) {
      ctx.ui.notify(`Could not open chat: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode === "tui" && process.platform !== "win32") {
      const owner = ++ownerGeneration;
      const id = ctx.sessionManager.getSessionId();
      const previousOwner = closeOwner;
      closeOwner = undefined;
      try {
        await previousOwner?.();
        if (owner !== ownerGeneration) return;
        const close = await registerSessionOwner(await ownerRegistry(), id, async () => {
          if (owner !== ownerGeneration || ctx.sessionManager.getSessionId() !== id) return "unavailable";
          if (active) return "already-open";
          return await runChatPage("", ctx) ? "attached" : "unavailable";
        });
        if (owner === ownerGeneration) closeOwner = close;
        else await close();
      } catch { /* /chat remains usable if local process discovery is unavailable. */ }
    }
    const target = process.env[AUTO_CHAT_SESSION];
    if (!target || !["startup", "resume", "fork"].includes(event.reason)) return;
    delete process.env[AUTO_CHAT_SESSION];
    if ((target === ctx.sessionManager.getSessionId() || target === "fork") && ctx.mode === "tui") await runChatPage("", ctx);
  });

  const complete = (prefix: string) => {
    const options = [
      { value: "link", label: "link", description: "Show the link without opening the browser" },
      { value: "close", label: "close", description: "Disconnect the current page" },
    ].filter(({ value }) => value.startsWith(prefix));
    return options.length ? options : null;
  };
  pi.registerCommand("chat", {
    description: "Open the current Pi session as a live browser chat",
    getArgumentCompletions: complete,
    handler: async (args, ctx) => { await runChatPage(args, ctx, ctx); },
  });
}
