import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export type CodexQuota = { left: number; resetsAt?: number };

export function readCodexQuota(): Promise<CodexQuota | undefined> {
  const command = process.platform === "darwin" && existsSync(bundledCodex) ? bundledCodex : "codex";
  return new Promise((resolve) => {
    const child = spawn(command, ["app-server"], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "ignore"],
      signal: AbortSignal.timeout(8_000),
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    function finish(quota?: CodexQuota) {
      if (finished) return;
      finished = true;
      resolve(quota);
      lines.close();
      if (!child.killed && child.exitCode === null) child.kill();
    }
    child.once("error", () => finish());
    child.once("close", () => finish());
    child.stdin.on("error", () => finish());
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
    lines.on("line", (line) => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply?.id === 1) {
        if (!reply.result) return finish();
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
      } else if (reply?.id === 2) {
        const result = reply.result;
        const quota = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
        if (quota?.limitId && quota.limitId !== "codex") return finish();
        const window = [quota?.primary, quota?.secondary].find((entry) => entry?.windowDurationMins === 300);
        const used = window?.usedPercent;
        if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return finish();
        // Codex reports the reset as a Unix timestamp in seconds.
        const resetsAt = window?.resetsAt;
        finish({ left: Math.round(100 - used), resetsAt: Number.isSafeInteger(resetsAt) && resetsAt > 0 ? resetsAt : undefined });
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi_chat", version: "0.1.0" } } });
  });
}
