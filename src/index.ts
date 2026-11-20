import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendToDraft, latestAssistantResponse } from "./annotations.ts";
import { startAnnotationServer } from "./server.ts";

function openPage(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Browser launcher exited with ${code}`)));
  });
}

export default function annotate(pi: ExtensionAPI) {
  let active: Awaited<ReturnType<typeof startAnnotationServer>> | undefined;
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
  pi.on("session_shutdown", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);

  const runPage = (command: "annotate" | "chat") =>
    async (args: string, ctx: ExtensionCommandContext) => {
      const value = args.trim();
      const alias = command === "annotate" && (value === "chat" || value === "chat link");
      const chat = command === "chat" || alias;
      const mode = alias ? value.slice(4).trim() : value;
      const name = chat ? "/chat" : "/annotate";
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`${name} requires Pi's terminal UI.`, "warning");
        return;
      }
      if (mode === "close") {
        stop();
        ctx.ui.notify("Browser page disconnected.", "info");
        return;
      }
      if (mode && mode !== "link") {
        ctx.ui.notify(`Usage: ${name} [link | close]`, "warning");
        return;
      }
      if (!chat && !ctx.isIdle()) {
        ctx.ui.notify("Wait until the response finishes before annotating.", "warning");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const response = chat ? undefined : latestAssistantResponse(branch);
      if (!chat && !response) {
        ctx.ui.notify("No assistant response with text on this branch yet.", "warning");
        return;
      }
      stop();
      const currentGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const anchor = chat ? branch.at(-1)?.id : response?.id;
      const isCurrent = () => generation === currentGeneration &&
        ctx.sessionManager.getSessionId() === sessionId &&
        (anchor === undefined || ctx.sessionManager.getBranch().some((entry) => entry.id === anchor));
      try {
        const opened = await startAnnotationServer({
          response,
          isCurrent,
          onClose: () => {
            if (generation === currentGeneration) {
              generation++;
              active = undefined;
            }
          },
          chat: chat ? {
            getBranch: () => ctx.sessionManager.getBranch(),
            isIdle: () => ctx.isIdle(),
            onSend: (content: Parameters<ExtensionAPI["sendUserMessage"]>[0]) => new Promise<void>((resolve) => {
              if (Array.isArray(content) && content.some((block) => block.type === "image")) {
                if (pi.getSettings().images?.blockImages) throw new Error("Images are disabled in Pi's settings.");
                if (!ctx.model?.input.includes("image")) throw new Error("The current Pi model cannot receive images. Choose an image-capable model in Pi.");
              }
              chatDispatch.run(resolve, () => pi.sendUserMessage(content, { expandPromptTemplates: false }));
            }),
          } : undefined,
          onSubmit: (text: string) => {
            if (!isCurrent()) throw new Error("Pi session/branch changed. Run /annotate again.");
            if (!ctx.isIdle()) throw new Error("Pi is busy. Wait for it to finish, then try Add to Pi again.");
            ctx.ui.setEditorText(appendToDraft(ctx.ui.getEditorText(), text));
            ctx.ui.notify("Annotations added to your draft. Review and press Enter when ready.", "info");
          },
        });
        if (!isCurrent()) {
          opened.close();
          return;
        }
        active = opened;
        const description = chat ? "Local chat (stays open while the tab is connected)" : "Local annotations (expires in 30 minutes)";
        ctx.ui.notify(`${description}: ${active.url}`, "info");
        if (mode !== "link") {
          // Only open a browser in response to the user's command, never on extension load.
          void openPage(active.url).catch(() => {
            if (isCurrent()) ctx.ui.notify("Could not open a browser. Open the local link above manually.", "warning");
          });
        }
      } catch (error) {
        ctx.ui.notify(`Could not open ${chat ? "chat" : "annotations"}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };

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
    handler: runPage("chat"),
  });
  pi.registerCommand("annotate", {
    description: "Annotate the latest reply and return questions to the terminal draft",
    getArgumentCompletions: complete,
    handler: runPage("annotate"),
  });
}
