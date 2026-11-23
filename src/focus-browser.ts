import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function isChatTab(value: unknown): value is string {
  return typeof value === "string" && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/\?tab=[a-f0-9]{32}$/.test(value);
}

function browser(userAgent: string) {
  if (/(?:Edg|OPR)\//.test(userAgent)) return;
  if (userAgent.includes("Chrome/")) return "Google Chrome";
  if (userAgent.includes("Version/") && userAgent.includes("Safari/")) return "Safari";
}

export function canFocusBrowser(userAgent: string) {
  return process.platform === "darwin" && !!browser(userAgent);
}

export function browserFocusArgs(tab: string, userAgent: string) {
  const app = browser(userAgent);
  if (!app || !isChatTab(tab)) return;
  const select = app === "Safari" ? "set current tab of w to t" : "set active tab index of w to i";
  return ["-e", `on run argv
  if application "${app}" is not running then return false
  set targetURL to item 1 of argv
  tell application "${app}"
    repeat with w in windows
      repeat with i from 1 to count of tabs of w
        set t to tab i of w
        if URL of t is targetURL then
          ${select}
          set index of w to 1
          activate
          return true
        end if
      end repeat
    end repeat
  end tell
  return false
end run`, tab];
}

/** Focus only the exact, server-generated local tab; never open a duplicate or navigate a tab. */
export async function focusBrowserChat(tab: string, userAgent: string) {
  const args = canFocusBrowser(userAgent) && browserFocusArgs(tab, userAgent);
  if (!args) return false;
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/osascript", args, { timeout: 10_000 });
    return stdout.trim() === "true";
  } catch {
    throw new Error("Could not switch tabs. Check macOS Automation permission for your browser, or select the existing chat tab manually.");
  }
}
