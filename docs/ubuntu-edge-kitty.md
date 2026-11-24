# Set up Pi Chat on Ubuntu with Edge and Kitty

The target is the same daily workflow as on the Mac: start Pi in a project, chat in the browser, find sessions on the dashboard, and jump back to the terminal that owns a chat. Install the existing extension first. Some Mac window-management actions have no Linux implementation; they are not missing settings.

## 1. Check the receiving machine

Run in a shell **directly in Kitty** on the Ubuntu desktop, not over SSH or inside tmux/screen:

```sh
pi --version
node --version
npm --version
kitty --version
command -v xdg-open
xdg-settings get default-web-browser
printf 'Desktop session: %s\n' "$XDG_SESSION_TYPE"
```

The reference Mac used Pi 1.3.0; the repository requires Node 22.19 or newer. Check the receiving checkout's [install requirements](../README.md#install) before changing versions. Use the Ubuntu user's own Pi login. Don't copy the Mac's Pi settings file, credentials, sessions, or absolute paths.

Linux opens pages through `xdg-open`. If Edge is already the HTTP handler, no browser configuration is needed. If another browser opens, either keep the default and use `/chat link` (for the dashboard, use the link printed by `/chat dashboard`), or ask before making Edge the user's default. Open links locally in a trusted Edge profile; they contain an access token. Don't paste them into an agent prompt or setup report. No browser automation, debugging port, MCP integration, or fixed web port is needed.

## 2. Install in a stable checkout

Reuse the existing `pi-chat` checkout if present; otherwise clone `https://github.com/TongVu/pi-chat.git` to a user-owned location you intend to keep. From its root:

```sh
git status --short --branch
git rev-parse --short HEAD
npm ci --omit=dev --ignore-scripts --legacy-peer-deps
pi install "$PWD"
```

On an existing install, check `pi list` first; don't register a second checkout or reset local changes. There is no build or background service. Start a fresh `pi` from the **project you want to chat about**, or finish any unsent drafts and use `/reload` in an existing Pi. Keep the hosting terminal running.

## 3. Enable **Switch to Terminal** in Kitty

This is optional for chat itself. If focus already works, leave Kitty alone. Otherwise inspect the effective Kitty config and its includes. Check `stat -c '%U %a %n' "$XDG_RUNTIME_DIR"`: it should be a directory owned by the desktop user with mode `700`. If missing or not private, stop here; don't put the socket in a shared location. Merge these settings into the user's Kitty config (normally `~/.config/kitty/kitty.conf`), preserving existing theme, mappings and includes:

```conf
allow_remote_control socket-only
listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}
```

Use a **local Unix socket only**; don't enable unrestricted remote control or a TCP listener. Have the user save work and start a fresh Kitty instance with the new settings. In its shell, check:

```sh
printf 'window=%s\nsocket=%s\n' "$KITTY_WINDOW_ID" "$KITTY_LISTEN_ON"
```

Expect a positive numeric window ID and a `unix:` address under the private runtime directory. Start Pi there. The extension uses `kitten @` (or `kitty @` if `kitten` is absent) to focus that exact window. On Wayland the correct Kitty tab can be selected without bringing the OS window in front of Edge. Check tab selection separately from foreground activation; don't change desktop sessions or keybindings to work around it.

### Dashboard tab switching

**Saved session:** To launch Pi in a new tab of the dashboard's Kitty window, Kitty
must permit the `launch` command on its private local socket. With `socket-only`
this already works. If using `allow_remote_control password`, keep the existing
focus/wallpaper allowlist. Generate a private launch-only password instead of
adding `launch` to the empty-password allowlist. In the Kitty config directory
(usually `~/.config/kitty`), run once, without overwriting existing files:

```sh
(umask 077; set -Ce; openssl rand -hex 32 > pi-chat-rc-pass
 IFS= read -r secret < pi-chat-rc-pass
 printf 'remote_control_password "%s" launch\n' "$secret" > pi-chat-launch.conf)
```

Add `include pi-chat-launch.conf` to `kitty.conf` and reload Kitty's configuration.
Do not share or commit either generated file. Pi Chat reads the password via Kitty's
`--password-file` option; it does not send it to the browser. If the socket isn't
available or Kitty denies a launch, use the manual command instead.

**Connected chat:** In Edge (`edge://extensions`) or Chrome (`chrome://extensions`),
turn on **Developer mode**, select **Load unpacked**, and choose `browser-extension/`
from this checkout. If an earlier experimental Pi Chat Tab Switcher is installed,
remove it first. Open `/chat dashboard` in the same profile as the chat tabs.
The extension only matches `http://127.0.0.1` pages. It activates an existing
chat without reloading, navigating, or opening a duplicate. No debugging port or
browser automation setup is required. Without the extension, select the tab manually.

**Browser closed, Pi still running:** No browser extension or Kitty launch permission
is needed. The dashboard asks that Pi to open a fresh connected browser tab. If the
same session is open in multiple Pi processes, it skips suspended jobs. If the
only owner is suspended (for example after Ctrl+Z), use `jobs` in its shell and
`fg %N` with the Pi job number, then click again; the dashboard does not wake it
or start a duplicate.

## 4. Verify with the user

Use a disposable project/session. The user operates Edge; an agent can check configuration and ask for the following observations without controlling the browser.

1. Run `pi --dashboard` in Kitty. Confirm the dashboard opens in Edge and lists the launch project. Leave this terminal running.
2. In a second Kitty tab start `pi` in the project and type `/chat`. In Edge send a harmless message. Confirm the reply appears in that tab and the same turn appears in Kitty. Check the model/effort picker. Select a passage and send an annotation; confirm Pi receives the quote and question.
3. Click **🕹️ Switch to Terminal** from the chat: it should select the second Kitty tab, without starting another Pi. From the dashboard the same button should select the *dashboard's* Kitty tab. Record any Wayland foreground limitation separately.
4. Leave a draft in the chat, switch to the dashboard and click the session. The original Edge tab should activate with its draft intact. Discard the test draft and close the browser tab. Click the session again: one new browser tab should connect to the same Pi, with no new Kitty tab. Finally exit the disposable Pi and click the saved session: exactly one new Kitty tab and one connected browser tab should open.

### Expected differences, not installation failures

- **Dashboard logo:** on Linux it can open another dashboard tab instead of selecting an existing one.
- **Create new chat** still provides a copyable command. The dashboard's one-click Kitty launcher resumes saved sessions only. In the explorer, one-click launch and clone remain Mac-only.

Report what passed on this desktop, what required a manual step, and what remains untested. Don't relax browser security as part of installation.

## Prompt for the Ubuntu agent

> Set up this checkout of pi-chat for Ubuntu, Edge and Kitty using `docs/ubuntu-edge-kitty.md`. Inspect the current setup first, reuse working settings, and make only the user-level changes needed. Ask before changing my default browser, restarting Kitty, or installing system packages. I'll operate Edge for the acceptance checks. Report working features separately from Mac-only actions and unverified checks. Don't change extension code or push anything.
