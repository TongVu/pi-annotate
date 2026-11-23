import { execFile } from "node:child_process";
import { promisify } from "node:util";

const terminalFocusScript = `on run argv
  set targetTTY to item 1 of argv
  if application id "com.apple.Terminal" is not running then return "missing"
  tell application id "com.apple.Terminal"
    repeat with terminalWindow in windows
      repeat with terminalTab in tabs of terminalWindow
        if tty of terminalTab is targetTTY then
          set selected of terminalTab to true
          set frontmost of terminalWindow to true
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

async function runCommand(command: string, args: string[]) {
  const { stdout } = await promisify(execFile)(command, args, { timeout: 30_000 });
  return stdout.trim();
}

export async function focusTerminal({ platform = process.platform, env = process.env, pid = process.pid, run = runCommand } = {}) {
  if (env.TMUX || env.STY) throw new Error("Switch to Terminal needs Pi to run directly in Terminal.app or Kitty, not inside tmux or screen.");
  if (platform === "darwin" && env.TERM_PROGRAM === "Apple_Terminal") {
    const tty = await run("/bin/ps", ["-o", "tty=", "-p", String(pid)]).catch(() => "");
    if (!/^ttys\d+$/.test(tty)) throw new Error("This Pi process has no Terminal.app tab to focus.");
    const result = await run("/usr/bin/osascript", ["-e", terminalFocusScript, `/dev/${tty}`]).catch(() => {
      throw new Error("Could not focus Terminal.app. Check macOS Automation permissions.");
    });
    if (result !== "focused") throw new Error("Could not find the Terminal.app tab running this chat.");
    return;
  }
  if (platform === "linux" && /^[1-9]\d*$/.test(env.KITTY_WINDOW_ID ?? "")) {
    const socket = env.KITTY_LISTEN_ON;
    if (!socket?.startsWith("unix:") || socket === "unix:") {
      throw new Error("Kitty needs a local remote-control socket. Enable it in kitty.conf and restart Kitty.");
    }
    const args = ["@", "--to", socket, "focus-window", "--match", `id:${env.KITTY_WINDOW_ID}`];
    try {
      await run("kitten", args).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
        return run("kitty", args); // Older Kitty releases use the main executable.
      });
    } catch {
      throw new Error("Could not focus the Kitty window. Check that Kitty remote control is enabled on its local socket.");
    }
    return;
  }
  throw new Error("Switch to Terminal is available for Terminal.app on macOS and Kitty on Linux.");
}
