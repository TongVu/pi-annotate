import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function isChatTab(value: unknown): value is string {
  return typeof value === "string" && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/\?tab=[a-f0-9]{32}$/.test(value);
}

export function isDashboardTab(value: string) {
  return /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/\?dashboard=[a-f0-9]{32}$/.test(value);
}

export function browserApp(userAgent: string) {
  if (/(?:Edg|OPR)\//.test(userAgent)) return;
  if (userAgent.includes("Chrome/")) return "Google Chrome";
  if (userAgent.includes("Version/") && userAgent.includes("Safari/")) return "Safari";
}

export function canFocusBrowser(userAgent: string) {
  return process.platform === "darwin" && !!browserApp(userAgent);
}

export function browserFocusArgs(tab: string, userAgent: string) {
  return isChatTab(tab) ? focusArgs([tab], userAgent) : undefined;
}

export function dashboardFocusArgs(tabs: string[], userAgent: string) {
  return focusArgs(tabs.filter(isDashboardTab), userAgent, true);
}

function focusArgs(tabs: string[], userAgent: string, dashboard = false) {
  const app = browserApp(userAgent);
  if (!app || !tabs.length) return;
  const match = dashboard ? `
        set tabURL to URL of t
        set foundTab to false
        if tabURL is not missing value then
          repeat with candidate in argv
            set locator to contents of candidate
            if tabURL is locator or tabURL starts with (locator & "#") then
              set foundTab to true
              exit repeat
            end if
          end repeat
        end if
        if foundTab then` : "\n        if URL of t is targetURL then";
  const select = app === "Safari" ? "set current tab of w to t" : "set active tab index of w to i";
  return ["-e", `on run argv
  if application "${app}" is not running then return false${dashboard ? "" : "\n  set targetURL to item 1 of argv"}
  tell application "${app}"
    repeat with w in windows
      repeat with i from 1 to count of tabs of w
        set t to tab i of w${match}
          ${select}
          set index of w to 1
          activate
          return true
        end if
      end repeat
    end repeat
  end tell
  return false
end run`, ...tabs];
}

/** Focus only the exact, server-generated local tab; never open a duplicate or navigate a tab. */
export async function focusBrowserChat(tab: string, userAgent: string) {
  const args = canFocusBrowser(userAgent) && browserFocusArgs(tab, userAgent);
  if (!args) return false;
  try {
    return await runFocus(args);
  } catch {
    throw new Error("Could not switch tabs. Check macOS Automation permission for your browser, or select the existing chat tab manually.");
  }
}

export async function focusBrowserDashboard(tabs: string[], userAgent: string) {
  const args = canFocusBrowser(userAgent) && dashboardFocusArgs(tabs, userAgent);
  return args ? runFocus(args) : false;
}

async function runFocus(args: string[]) {
  const { stdout } = await promisify(execFile)("/usr/bin/osascript", args, { timeout: 10_000 });
  return stdout.trim() === "true";
}
