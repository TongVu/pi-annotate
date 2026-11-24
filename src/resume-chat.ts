import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

// Keep the existing launch handoff compatible with already-running Pi processes.
export const AUTO_CHAT_SESSION = "PI_ANNOTATE_AUTO_CHAT_SESSION";
export const NEW_CHAT_TARGET = "new";

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

function browserPiCommand(pi: string, extension: string, agentDir: string, target: string, sessionArgs: string[] = []) {
  return [
    "/usr/bin/env", shellQuote(`PI_CODING_AGENT_DIR=${agentDir}`), shellQuote(`${AUTO_CHAT_SESSION}=${target}`),
    shellQuote(pi), ...sessionArgs, "--extension", shellQuote(extension),
  ].join(" ");
}

function terminalLaunchArgs({ id, cwd, path }: { id: string; cwd: string; path: string }, pi: string, extension: string, agentDir: string, operation: "--session" | "--fork") {
  const run = browserPiCommand(pi, extension, agentDir, id, [operation, shellQuote(path)]);
  return ["-e", terminalScript, `cd -- ${shellQuote(cwd)} && /bin/test -s ${shellQuote(path)} && ${run}`];
}

export function terminalNewArgs(cwd: string, pi: string, extension: string, agentDir: string) {
  return ["-e", terminalScript, `cd -- ${shellQuote(cwd)} && ${browserPiCommand(pi, extension, agentDir, NEW_CHAT_TARGET)}`];
}

async function findPi() {
  const candidates = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((dir) => join(dir, "pi"));
  const managed = process.env.PI_MANAGED_INSTALL_ROOT;
  if (managed && isAbsolute(managed)) candidates.unshift(join(dirname(managed), "bin", "pi"));
  for (const path of candidates) {
    if (await stat(path).then((entry) => entry.isFile(), () => false) && await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  throw new Error("Could not find the Pi executable. Open Pi manually from the project directory.");
}

async function openTerminal(args: string[]) {
  try {
    await promisify(execFile)("/usr/bin/osascript", args, { timeout: 30_000 });
  } catch {
    throw new Error("Could not open Terminal. Check macOS Automation permissions.");
  }
}

async function validateSavedChat(session: { cwd: string; path: string }) {
  if (!isAbsolute(session.cwd) || !await stat(session.cwd).then((entry) => entry.isDirectory(), () => false)) {
    throw new Error("The chat’s original project directory is unavailable.");
  }
  if (!isAbsolute(session.path) || !await stat(session.path).then((entry) => entry.isFile() && entry.size > 0, () => false)) {
    throw Object.assign(new Error("The saved chat file is no longer available."), { status: 404 });
  }
}

export function kittyDashboardTarget(env = process.env) {
  if (env.TMUX || env.STY || env.SSH_CONNECTION || !/^[1-9]\d*$/.test(env.KITTY_WINDOW_ID ?? "")) return;
  if (!env.KITTY_LISTEN_ON?.startsWith("unix:/")) return;
  return { socket: env.KITTY_LISTEN_ON, windowId: env.KITTY_WINDOW_ID! };
}

// A negative reply is safe to fall back from. A timeout is ambiguous: never retry a launch.
export async function resumeInKitty(session: { id: string; cwd: string; path: string }, extension: string, agentDir: string, target: NonNullable<ReturnType<typeof kittyDashboardTarget>>) {
  await validateSavedChat(session);
  const pi = await findPi();
  const config = process.env.KITTY_CONFIG_DIRECTORY || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kitty");
  const password = join(config, "pi-chat-rc-pass");
  const auth = await access(password, constants.R_OK).then(() => ["--password-file", password, "--use-password", "always"], () => ["--use-password", "never"]);
  try {
    await promisify(execFile)("kitty", ["@", "--to", target.socket, ...auth, "launch", "--type=tab", "--match", `window_id:${target.windowId}`,
      "--cwd", session.cwd, "--env", `PATH=${process.env.PATH}`, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", `${AUTO_CHAT_SESSION}=${session.id}`,
      "--", pi, "--session", session.path, "--extension", extension], { timeout: 10_000 });
  } catch (error) {
    if (error.code === "ENOENT" || /remote control is disabled|disallowed by remote_control_password|No matching tabs/i.test(error.stderr ?? "")) return false;
    throw new Error("Could not confirm the Kitty launch. Check the dashboard’s Kitty window before trying again.");
  }
}

async function launchChatInTerminal(session: { id?: string; cwd: string; path: string }, extension: string, agentDir: string, operation: "resume" | "fork") {
  await validateSavedChat(session);
  const pi = await findPi();
  const args = operation === "resume"
    ? terminalResumeArgs({ ...session, id: session.id ?? "" }, pi, extension, agentDir)
    : terminalForkArgs(session, pi, extension, agentDir);
  await openTerminal(args);
}

export async function startNewChatInTerminal(cwd: string, extension: string, agentDir: string) {
  if (!isAbsolute(cwd) || !await stat(cwd).then((entry) => entry.isDirectory(), () => false)) {
    throw new Error("That project directory is unavailable.");
  }
  await openTerminal(terminalNewArgs(cwd, await findPi(), extension, agentDir));
}

export async function resumeChatInTerminal(session: { id: string; cwd: string; path: string }, extension: string, agentDir: string) {
  return launchChatInTerminal(session, extension, agentDir, "resume");
}

export async function forkChatInTerminal(session: { cwd: string; path: string }, extension: string, agentDir: string) {
  return launchChatInTerminal(session, extension, agentDir, "fork");
}
