import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export const AUTO_CHAT_SESSION = "PI_ANNOTATE_AUTO_CHAT_SESSION";

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const terminalScript = `on run argv
  set commandText to item 1 of argv
  tell application "Terminal"
    do script commandText
    activate
  end tell
end run`;

export function terminalResumeArgs({ id, cwd, path }: { id: string; cwd: string; path: string }, pi: string, extension: string, agentDir: string) {
  return terminalLaunchArgs({ id, cwd, path }, pi, extension, agentDir, "--session");
}

export function terminalForkArgs({ cwd, path }: { cwd: string; path: string }, pi: string, extension: string, agentDir: string) {
  return terminalLaunchArgs({ id: "fork", cwd, path }, pi, extension, agentDir, "--fork");
}

function terminalLaunchArgs({ id, cwd, path }: { id: string; cwd: string; path: string }, pi: string, extension: string, agentDir: string, operation: "--session" | "--fork") {
  const command = [
    "cd --", shellQuote(cwd), "&& /bin/test -s", shellQuote(path), "&& /usr/bin/env",
    shellQuote(`PI_CODING_AGENT_DIR=${agentDir}`), shellQuote(`${AUTO_CHAT_SESSION}=${id}`),
    shellQuote(pi), operation, shellQuote(path), "--extension", shellQuote(extension),
  ].join(" ");
  return ["-e", terminalScript, command];
}

async function findPi() {
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((dir) => join(dir, "pi"));
  const managed = process.env.PI_MANAGED_INSTALL_ROOT;
  if (managed && isAbsolute(managed)) candidates.unshift(join(dirname(managed), "bin", "pi"));
  for (const path of candidates) {
    if (await stat(path).then((entry) => entry.isFile(), () => false) && await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  throw new Error("Could not find the Pi executable. Use Copy resume command instead.");
}

async function launchChatInTerminal(session: { id?: string; cwd: string; path: string }, extension: string, agentDir: string, operation: "resume" | "fork") {
  if (!isAbsolute(session.cwd) || !await stat(session.cwd).then((entry) => entry.isDirectory(), () => false)) {
    throw new Error("The chat’s original project directory is unavailable.");
  }
  if (!isAbsolute(session.path) || !await stat(session.path).then((entry) => entry.isFile() && entry.size > 0, () => false)) {
    throw Object.assign(new Error("The saved chat file is no longer available."), { status: 404 });
  }
  const pi = await findPi();
  try {
    const args = operation === "resume"
      ? terminalResumeArgs({ ...session, id: session.id ?? "" }, pi, extension, agentDir)
      : terminalForkArgs(session, pi, extension, agentDir);
    await promisify(execFile)("/usr/bin/osascript", args, { timeout: 30_000 });
  } catch {
    throw new Error("Could not open Terminal. Check macOS Automation permissions.");
  }
}

export async function resumeChatInTerminal(session: { id: string; cwd: string; path: string }, extension: string, agentDir: string) {
  return launchChatInTerminal(session, extension, agentDir, "resume");
}

export async function forkChatInTerminal(session: { cwd: string; path: string }, extension: string, agentDir: string) {
  return launchChatInTerminal(session, extension, agentDir, "fork");
}
