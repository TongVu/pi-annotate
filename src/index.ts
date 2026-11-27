import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startChatServer } from "./server.ts";
import { createChatNoteStore } from "./chat-notes.ts";
import { saveChatAttachments } from "./chat-attachments.ts";
import { createSubchat, isBranchableReply, listPiSessions, readPiSession } from "./session-explorer.ts";
import { createChatPresence } from "./chat-presence.ts";
import { AUTO_CHAT_SESSION, NEW_CHAT_TARGET, forkChatInKitty, forkChatInTerminal, kittyDashboardTarget, resumeInKitty, resumeChatInTerminal, shellQuote, startVerifyChat, startNewChatInKitty, startNewChatInTerminal } from "./resume-chat.ts";
import { registerSessionOwner, requestOwnedChat } from "./session-owner.ts";
import { focusTerminal } from "./focus-terminal.ts";
import { listDashboardTabs, startDashboard } from "./dashboard.ts";
import { browserApp, focusBrowserDashboard } from "./focus-browser.ts";
import { canArchiveSessions, trashExpiredArchives } from "./session-archive.ts";
import { createAgentTeam, createTeamWorker, prepareTeamWorkspace, resolveTeamModel, teamThinkingLevel } from "./agent-team.ts";

// Keep the existing registry names so running Pi processes can still discover each other.
const ownerRegistry = (agentDir: string) => join(agentDir, "pi-annotate-owners");
const presenceRegistry = (agentDir: string) => join(agentDir, "pi-annotate-live");
const dashboardRegistry = (agentDir: string) => join(agentDir, "pi-chat-dashboards");
const archiveRoot = (agentDir: string) => join(agentDir, "pi-chat", "archive");
const agentDirPath = async () => (await import("@earendil-works/pi-coding-agent")).getAgentDir();

function openPage(url: string, userAgent?: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const app = process.platform === "darwin" && userAgent ? browserApp(userAgent) : undefined;
  const args = app ? ["-a", app, url] : process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Browser launcher exited with ${code}`)));
  });
}

export default function piChat(pi: ExtensionAPI) {
  registerChatExtension(pi, openPage);
}

export function registerChatExtension(pi: ExtensionAPI, launchPage: (url: string, userAgent?: string) => Promise<void>, {
  focusDashboard = focusBrowserDashboard, getAgentDir = agentDirPath, listSessions = listPiSessions,
} = {}) {
  pi.registerFlag("dashboard", { type: "boolean", default: false, description: "Open the Pi Chat dashboard at startup" });
  let active: Awaited<ReturnType<typeof startChatServer>> | undefined;
  let sessionTeam: { id: string; team: ReturnType<typeof createAgentTeam> } | undefined;
  let dashboard: ReturnType<typeof startDashboard> | undefined;
  let archiveTimer: ReturnType<typeof setInterval> | undefined;
  let archiveSweep: Promise<void> | undefined;
  let sessionOwner: Awaited<ReturnType<typeof registerSessionOwner>> | undefined;
  let ownerGeneration = 0;
  let generation = 0;
  type ChatDispatch = { requestId?: string; confirm: () => void; accepted: boolean };
  const chatDispatch = new AsyncLocalStorage<ChatDispatch>();
  let activeDispatch: ChatDispatch | undefined;
  pi.on("message_start", (event) => {
    // A terminal message delivered into the same run must not be stopped by the old browser action.
    if (event.message.role === "user" && activeDispatch?.accepted) activeDispatch = undefined;
  });
  pi.on("message_end", (event) => {
    // This callback belongs to the async Pi run started by this browser send,
    // not a concurrent terminal prompt. A transformed input is still accepted.
    const dispatch = chatDispatch.getStore();
    if (event.message.role === "user" && dispatch && !dispatch.accepted) {
      dispatch.accepted = true;
      dispatch.confirm();
    }
  });
  pi.on("agent_start", () => {
    const dispatch = chatDispatch.getStore();
    activeDispatch = dispatch && !dispatch.accepted ? dispatch : undefined;
    sessionOwner?.setWorking(true);
  });
  pi.on("agent_end", () => {
    activeDispatch = undefined;
    sessionOwner?.setWorking(false);
  });
  const stop = () => {
    generation++;
    active?.close();
    active = undefined;
  };
  const closeTeam = () => {
    sessionTeam?.team.close();
    sessionTeam = undefined;
  };
  pi.on("session_shutdown", async () => {
    clearInterval(archiveTimer);
    archiveTimer = undefined;
    stop();
    closeTeam();
    ownerGeneration++;
    const owner = sessionOwner;
    sessionOwner = undefined;
    const closing = dashboard;
    dashboard = undefined;
    await Promise.all([owner?.close(), closing?.then((opened) => opened.close(), () => {})]);
  });
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);

  const openDashboard = async (ctx: ExtensionContext, userAgent?: string) => {
    const currentGeneration = generation;
    const agentDir = await getAgentDir();
    const registry = dashboardRegistry(agentDir);
    if (userAgent) {
      const tabs = await listDashboardTabs(registry);
      if (tabs.length && await focusDashboard(tabs, userAgent).catch(() => false)) return;
    }
    if (generation !== currentGeneration) throw new Error("The Pi session changed. Run /chat dashboard again.");
    const sessionDir = ctx.sessionManager.getSessionDir();
    const project = ctx.sessionManager.getCwd();
    const kitty = process.platform === "linux" ? kittyDashboardTarget() : undefined;
    const pending = dashboard ??= startDashboard({
      list: () => listSessions(sessionDir),
      project,
      presenceDir: presenceRegistry(agentDir),
      ownerDir: ownerRegistry(agentDir),
      bookmarkDir: join(agentDir, "pi-chat-bookmarks"),
      archiveDir: canArchiveSessions ? archiveRoot(agentDir) : undefined,
      tabRegistry: registry,
      verifyChat: process.platform === "darwin" || kitty ? (cwd, name) => startVerifyChat(cwd, name, fileURLToPath(import.meta.url), agentDir, kitty) : undefined,
      focusTerminal,
      ...(process.platform === "darwin" ? {
        resume: (session) => resumeChatInTerminal(session, fileURLToPath(import.meta.url), agentDir),
        createChat: (cwd) => startNewChatInTerminal(cwd, fileURLToPath(import.meta.url), agentDir),
      } : kitty ? {
        resume: (session) => resumeInKitty(session, fileURLToPath(import.meta.url), agentDir, kitty),
        createChat: (cwd) => startNewChatInKitty(cwd, fileURLToPath(import.meta.url), agentDir, kitty),
      } : {}),
    });
    const opened = await pending.catch((error) => {
      if (dashboard === pending) dashboard = undefined;
      throw error;
    });
    if (dashboard !== pending) throw new Error("The Pi session changed. Run /chat dashboard again.");
    if (userAgent === undefined) ctx.ui.notify(`Local chat dashboard: ${opened.url}`, "info");
    try { await launchPage(opened.url, userAgent); }
    catch { throw new Error("Could not launch a browser. Run /chat dashboard in Pi to get the local link."); }
  };

  const showDashboardInTerminal = async (ctx: ExtensionContext) => {
    try {
      await openDashboard(ctx);
    } catch (error) {
      ctx.ui.notify(`Could not open dashboard: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const runChatPage = async (args: string, ctx: ExtensionContext) => {
    const mode = args.trim();
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/chat requires Pi's terminal UI.", "warning");
      return;
    }
    if (mode === "dashboard") {
      await showDashboardInTerminal(ctx);
      return;
    }
    if (mode === "close") {
      stop();
      ctx.ui.notify("Browser page disconnected.", "info");
      return;
    }
    if (mode && mode !== "link") {
      ctx.ui.notify("Usage: /chat [link | close | dashboard]", "warning");
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
    const modelKey = (model: NonNullable<ExtensionContext["model"]>) => JSON.stringify([model.provider, model.id]);
    const availableModels = () => ctx.scopedModels.length
      ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
    const describeModel = (model: NonNullable<ExtensionContext["model"]>) => ({ key: modelKey(model), label: `${model.name || model.id} (${model.provider})` });
    const getModelSettings = async () => {
      const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
      const model = ctx.model;
      return {
        model: model && describeModel(model),
        models: availableModels().map(describeModel),
        effort: pi.getThinkingLevel(),
        efforts: model ? getSupportedThinkingLevels(model) : [],
      };
    };
    try {
      const sessionDir = ctx.sessionManager.getSessionDir();
      // Keep the existing path so the repository rename doesn't strand saved notes.
      const noteStore = createChatNoteStore(join(sessionDir, ".pi-annotate-notes"));
      const attachmentDir = join(sessionDir || await getAgentDir(), ".pi-chat-attachments");
      // A /chat listener is only a view. Team state belongs to the running Pi session.
      if (!isCurrent()) return;
      if (sessionTeam?.id !== sessionId) {
        closeTeam();
        let teamModel: ExtensionContext["model"];
        sessionTeam = { id: sessionId, team: createAgentTeam({
          prepare: async ({ hasImages, workspace }) => {
            const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
            teamModel = resolveTeamModel(ctx.modelRegistry.getAvailable(), getSupportedThinkingLevels);
            if (hasImages && pi.getSettings().images?.blockImages) throw new Error("Images are disabled in Pi’s settings.");
            if (hasImages && !teamModel.input.includes("image")) throw new Error("GPT-6 Luna cannot receive images in this Pi setup.");
            return workspace ?? prepareTeamWorkspace(ctx.sessionManager.getCwd(), join(await getAgentDir(), "pi-chat-teams"));
          },
          saveAttachments: (items) => saveChatAttachments(attachmentDir, sessionId, items),
          openWorker: async (worker) => createTeamWorker({ ...worker, agentDir: await getAgentDir(), model: teamModel, thinkingLevel: teamThinkingLevel }),
        }) };
      }
      const kitty = process.platform === "linux" ? kittyDashboardTarget() : undefined;
      const opened = await startChatServer({
        isCurrent,
        closeTeamOnClose: false,
        onClose: () => {
          if (generation === currentGeneration) {
            generation++;
            active = undefined;
          }
        },
        chat: {
          noteStore,
          attachmentDir,
          team: sessionTeam.team,
          getSessionId: () => ctx.sessionManager.getSessionId(),
          getSessionName: () => ctx.sessionManager.getSessionName(),
          setSessionName: (sessionName: string) => pi.setSessionName(sessionName),
          focusTerminal,
          openDashboard: (userAgent: string) => openDashboard(ctx, userAgent),
          presence: createChatPresence(async () => presenceRegistry(await agentDirPath()), () => {
            const { id, cwd, name } = chatIdentity();
            return { id, cwd, name };
          }),
          explorer: {
            current: chatIdentity,
            list: () => listSessions(ctx.sessionManager.getSessionDir()),
            read: readPiSession,
            ...(process.platform === "darwin" ? {
              launch: async (session) => {
                const agentDir = await agentDirPath();
                const outcome = await requestOwnedChat(ownerRegistry(agentDir), session.id);
                if (outcome === "attached" || outcome === "already-open") return outcome;
                if (outcome !== "missing") throw new Error("This session is open in Pi but could not open a browser tab. Run /chat in its Terminal; no second Pi was started.");
                await resumeChatInTerminal(session, fileURLToPath(import.meta.url), agentDir);
                return "launched";
              },
              clone: async (session) => forkChatInTerminal(session, fileURLToPath(import.meta.url), await getAgentDir()),
            } : kitty ? {
              clone: async (session) => forkChatInKitty(session, fileURLToPath(import.meta.url), await getAgentDir(), kitty),
            } : {}),
          },
          onBranch: chatIdentity().path && (async (replyId: string, name: string) => {
            const child = await createSubchat(() => {
              if (!isCurrent() || !ctx.sessionManager.getBranch().some((entry) => entry.id === replyId && isBranchableReply(entry))) return;
              const parent = chatIdentity();
              if (parent.path) return { ...parent, path: parent.path, dir: sessionDir };
            }, replyId, name);
            try {
              const extension = fileURLToPath(import.meta.url);
              if (process.platform === "darwin") {
                await resumeChatInTerminal(child, extension, await getAgentDir());
                return { launched: true };
              }
              if (kitty && await resumeInKitty(child, extension, await getAgentDir(), kitty) !== false) return { launched: true };
            } catch (error) {
              // The launcher may have started Pi before failing. Don't suggest a second launch yet.
              return { message: `Subchat saved. ${error instanceof Error ? error.message : "Could not confirm the launch."}` };
            }
            return {
              message: "Subchat saved. Run the resume command in Terminal, then type /chat in Pi.",
              command: `cd -- ${shellQuote(child.cwd)} && pi --session ${shellQuote(child.path)}`,
            };
          }),
          getBranch: () => ctx.sessionManager.getBranch(),
          isIdle: () => ctx.isIdle(),
          getContextUsage: () => ctx.getContextUsage(),
          getModelSettings,
          setModelSettings: async (change: { model?: string; effort?: string }) => {
            if (change.model !== undefined) {
              const model = availableModels().find((candidate) => modelKey(candidate) === change.model);
              if (!model) throw new Error("Choose an available model from this chat’s model cycle.");
              if (!await pi.setModel(model)) throw new Error("This model’s provider is not signed in. Check authentication in Pi.");
            } else {
              const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
              const model = ctx.model;
              const level = model && getSupportedThinkingLevels(model).find((effort) => effort === change.effort);
              if (!level) throw new Error("This thinking effort is not supported by the current model.");
              if (!ctx.isIdle()) throw new Error("Pi is busy. Wait for it to finish and retry.");
              pi.setThinkingLevel(level);
            }
          },
          onCompact: () => new Promise<void>((resolve, reject) => {
            ctx.compact({ onComplete: () => resolve(), onError: reject });
          }),
          getStoppableRequestId: () => activeDispatch?.accepted && !ctx.isIdle() && !ctx.hasPendingMessages()
            ? activeDispatch.requestId : undefined,
          onStop: () => ctx.abort(),
          onSend: (content: Parameters<ExtensionAPI["sendUserMessage"]>[0], requestId?: string) => new Promise<void>((resolve) => {
            if (Array.isArray(content) && content.some((block) => block.type === "image")) {
              if (pi.getSettings().images?.blockImages) throw new Error("Images are disabled in Pi's settings.");
              if (!ctx.model?.input.includes("image")) throw new Error("The current Pi model cannot receive images. Choose an image-capable model in Pi.");
            }
            chatDispatch.run({ requestId, confirm: resolve, accepted: false },
              () => pi.sendUserMessage(content, { expandPromptTemplates: false }));
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
    if (sessionTeam && sessionTeam.id !== ctx.sessionManager.getSessionId()) closeTeam();
    if (ctx.mode === "tui" && canArchiveSessions && !archiveTimer) {
      const sweep = () => {
        archiveSweep ??= getAgentDir().then((dir) => trashExpiredArchives(archiveRoot(dir)))
          .catch(() => {}).finally(() => { archiveSweep = undefined; });
      };
      sweep();
      archiveTimer = setInterval(sweep, 60 * 60 * 1000).unref();
    }
    if (event.reason === "startup" && pi.getFlag("dashboard") === true) {
      if (ctx.mode === "tui") await showDashboardInTerminal(ctx);
      // An empty launcher isn't a disconnected chat.
      if (!ctx.sessionManager.getBranch().some(({ type }) => type === "message")) return;
    }
    if (ctx.mode === "tui" && process.platform !== "win32") {
      const owner = ++ownerGeneration;
      const id = ctx.sessionManager.getSessionId();
      const previousOwner = sessionOwner;
      sessionOwner = undefined;
      try {
        await previousOwner?.close();
        if (owner !== ownerGeneration) return;
        const registered = await registerSessionOwner(ownerRegistry(await agentDirPath()), {
          id, cwd: ctx.sessionManager.getCwd(), name: ctx.sessionManager.getSessionName(),
        }, async () => {
          if (owner !== ownerGeneration || ctx.sessionManager.getSessionId() !== id) return "unavailable";
          if (active) return "already-open";
          return await runChatPage("", ctx) ? "attached" : "unavailable";
        }, () => {
          if (owner !== ownerGeneration || ctx.sessionManager.getSessionId() !== id || active) return false;
          const busy = !ctx.isIdle();
          ctx.shutdown();
          if (busy) ctx.abort();
          return true;
        });
        if (owner === ownerGeneration) sessionOwner = registered;
        else await registered.close();
      } catch { /* /chat remains usable if local process discovery is unavailable. */ }
    }
    const target = process.env[AUTO_CHAT_SESSION];
    if (!target || !["startup", "resume", "fork"].includes(event.reason)) return;
    delete process.env[AUTO_CHAT_SESSION];
    const fresh = target === NEW_CHAT_TARGET && event.reason === "startup";
    if ((fresh || target === ctx.sessionManager.getSessionId() || target === "fork") && ctx.mode === "tui") await runChatPage("", ctx);
  });

  const complete = (prefix: string) => {
    const options = [
      { value: "link", label: "link", description: "Show the link without opening the browser" },
      { value: "close", label: "close", description: "Disconnect the current page" },
      { value: "dashboard", label: "dashboard", description: "Open the dashboard for all chats" },
    ].filter(({ value }) => value.startsWith(prefix));
    return options.length ? options : null;
  };
  pi.registerCommand("chat", {
    description: "Open a browser chat for this Pi session directly",
    getArgumentCompletions: complete,
    handler: runChatPage,
  });
}
