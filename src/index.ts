import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  const stop = () => {
    generation++;
    active?.close();
    active = undefined;
  };
  pi.on("session_shutdown", stop);
  pi.on("session_before_switch", stop);
  pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop);

  pi.registerCommand("annotate", {
    description: "Annotate the latest assistant response in a local browser; return comments to the draft editor",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/annotate requires Pi's terminal UI.", "warning");
        return;
      }
      if (args.trim() === "close") {
        stop();
        ctx.ui.notify("Annotation window disconnected.", "info");
        return;
      }
      if (args.trim() && args.trim() !== "link") {
        ctx.ui.notify("Usage: /annotate, /annotate link (do not open browser), /annotate close", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait until the response finishes before annotating.", "warning");
        return;
      }
      const response = latestAssistantResponse(ctx.sessionManager.getBranch());
      if (!response) {
        ctx.ui.notify("No assistant response with text on this branch yet.", "warning");
        return;
      }
      stop();
      const currentGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const isCurrent = () => generation === currentGeneration &&
        ctx.sessionManager.getSessionId() === sessionId &&
        ctx.sessionManager.getBranch().some((entry) => entry.id === response.id);
      try {
        const opened = await startAnnotationServer({
          response,
          isCurrent,
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
        ctx.ui.notify(`Local annotations (expires in 30 minutes): ${active.url}`, "info");
        if (args.trim() !== "link") {
          // Opening is a direct consequence of the user's /annotate command, never extension load.
          void openPage(active.url).catch(() => {
            if (isCurrent()) ctx.ui.notify("Could not open a browser. Open the local annotation link above manually.", "warning");
          });
        }
      } catch (error) {
        ctx.ui.notify(`Could not start annotations: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
