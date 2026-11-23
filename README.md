# Pi Chat

A local Pi extension for managing chat sessions by project, chatting in the
browser, and asking questions about passages in assistant replies.

## Try it

Requires Pi 1.3.0 and Node.js 22.19+. There is no build step. From this repository
root, install the local Markdown-rendering dependencies once:

```sh
npm ci --omit=dev --ignore-scripts --legacy-peer-deps
```

Install the local extension once, then open the dashboard:

```sh
pi install /path/to/pi-chat
pi --dashboard
```

Replace `/path/to/pi-chat` with your checkout's absolute path. To try it without
installing, run `pi --extension /path/to/pi-chat/src/index.ts --dashboard`.
Run the dashboard from a project directory if you want to start its first chat.
Keep the Pi terminal that opened the dashboard running. Both regular and
fullscreen terminal modes work.

### Live browser chat

1. Open or create a chat from the dashboard. To attach directly to an
   already-running Pi session, run `/chat` in its terminal, or use `/chat link`
   to open the link yourself. A named session appears by name in its browser tab.
2. Type a message in the bottom composer, or select text in a Pi reply and click
   **Add annotation** to write a question. You can also copy the selected text
   normally without opening the dialog. Keep reusable Markdown in the right-panel note;
   it saves locally per chat in Pi's data directory, survives closing and
   reopening `/chat`, and can be previewed or copied as Markdown. The dots stay
   centered on the left as you scroll; the current turn is blue.
   Hover to preview a message or click to jump to it.
3. Press **Enter** or click the checkmark button to send an ordinary message.
   **Shift+Enter** inserts a newline. Click **Send questions** to submit the
   annotation batch. You can paste a screenshot into an annotation's comment
   field or attach images with its clipboard button. Each question keeps its own
   images. These are separate sends: each leaves the other draft untouched and
   clears its own draft only after Pi accepts it. The terminal draft is untouched.
4. New messages appear in the same tab as Pi finishes them. The dot next to 👾
   pulses amber while Pi is working and green when it's ready. Replies aren't streamed
   token by token. If Pi needs an approval or other interactive input, use the terminal.

Click **👾** in the composer to view or change this chat’s model and thinking effort. The picker uses Pi’s model cycle and shows only the effort levels the selected model supports. Changes are available when Pi is idle and do not affect defaults for new chats.

Click the **Context usage** ring in the composer to see Pi's estimated token usage and the model's context limit. Click **Compact chat** when Pi is idle and confirm to summarize older context without removing messages from the transcript. After compaction, Pi reports usage again after its next reply.

Click the live chat title to rename the session.
Click **🕹️** beside the live chat name to switch to the terminal tab running
that chat. It does not start Pi, open a new tab, or send text to the terminal.
On macOS, use Terminal.app and allow Terminal Automation if prompted. On Linux,
Kitty needs a local remote-control socket. For example, in `kitty.conf`, use:

```conf
allow_remote_control socket-only
listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}
```

Use this path only if `XDG_RUNTIME_DIR` is set to your private runtime directory.
Restart Kitty and start Pi directly in a new Kitty shell so Pi inherits the socket
address. On Wayland, the compositor may not bring Kitty in front of the browser.

Click the **Attach files** clipboard icon to select multiple files, or paste a
screenshot into the composer. Draft images show a thumbnail; click it or the
filename to inspect a larger local preview before sending. Sent images can also
be opened from the thumbnails in the conversation. Send up to 10 UTF-8
text/code files or PNG, JPEG, GIF, and WebP images, with or without a message.
Limits are 5 MiB per file, 10 MiB combined, and 128 KiB
combined for text files. The same image limits apply across an annotation batch.
PDFs, Office documents, and archives aren't supported.
Images require an image-capable model and must not be blocked in Pi settings.

Chat submissions start a normal Pi turn with the session's model and tools. They
aren't interpreted as slash commands. If a send can't be confirmed, the draft stays
in the browser; retrying the unchanged send checks the same request rather than
starting another turn. If Pi never confirms it, check the terminal and reopen the
chat before sending again. Live chat was verified with Pi 1.5.2.

### Chat dashboard

Run `pi --dashboard` from your shell. From a running Pi session, `/chat dashboard`
or the logo in the explorer controls opens the dashboard without losing a chat draft.
The sidebar groups sessions by their original project directory. Filter by
**Name or directory** to narrow the sidebar, cards, and counts. **All sessions**
shows every group; **Needs attention** shows connected chats that are ready for
input or whose last turn stopped. Its status counts still include all matching
chats. Pulsing amber and green dots mark working and ready chats, respectively.
Status updates even when the chat tab is in the background.

- **🕹️ Switch to Terminal** focuses the Pi terminal hosting the dashboard, not
  the terminal for a selected chat. It supports Terminal.app on macOS and Kitty
  on Linux with local remote control enabled.
- **Go to tab** on macOS switches to the existing tab in Chrome or Safari without
  reloading it or discarding its draft. macOS may ask for Automation permission.
  On unsupported browsers or when the tab can't be found, select it manually;
  the dashboard never opens a replacement for a connected chat.
- **Reopen chat** asks the running Pi session to open a fresh tab. It does not
  start a second Pi or interrupt an ongoing turn.
- **Resume chat** starts the saved session in its original project via Terminal
  on macOS. On other platforms, copy the resume command, then run `/chat` in Pi.
- **Create new chat** asks you to choose a dashboard project, including the one
  you launched the dashboard from, even if it has no chats yet. On macOS
  it starts a fresh Pi in that directory and opens its chat in a new tab, leaving
  existing chats and drafts alone. On other platforms, copy the start command,
  then run `/chat` in Pi.

The dashboard lists saved sessions in Pi's default store and this Pi's custom
store, if any, plus chats advertised by other running Pi instances using the
same agent directory. Reload older Pi instances and reopen their chat pages to
publish the new status and tab locator. The dashboard has its own local server:
`/chat close` closes only the chat tab's connection, but exiting or replacing the
Pi session that opened the dashboard (including `/reload`) closes the dashboard
server too.

### Chat explorer

Click the sidebar icon in a live chat to open the left explorer. To create a
session, use **Create new chat** on the dashboard. The explorer groups sessions by
project directory, with forked sessions nested under their Pi parent session
when that parent is available. Click a project heading to collapse or expand its
sessions. Type a session name or directory to filter the list; matches appear
even in collapsed projects. Use **Collapse all** or **Expand all** to change
every folder. The pin button clears the filter if needed, opens only the current
chat's project folder, and scrolls that chat into view. Unnamed saved sessions
use the first message when available. Click the refresh icon to
pick up newer sessions. Long chat names are clamped to two lines; hover or focus
a name to preview its full text.

Green dots mark sessions with an open `/chat` tab under the same Pi agent setup;
inactive, read-only sessions have no status dot. Only the session attached to
this tab can receive messages here; use the original tab to send to another green chat.
On macOS, open an inactive session and click **Resume in browser**. If Pi is already
running that session with the current extension loaded, it opens a browser tab
from the existing process, so any in-progress turn keeps running. Otherwise it
starts the exact session in a new Terminal window from its original project
directory. Neither path sends a message. If macOS asks for Terminal Automation
permission or Pi asks for project approval, respond in Terminal. Chats already
open in another browser tab are not launched again.

Hover over a yellow session (or tab to its controls) to copy the manual resume
command, including on other platforms. Click **Back to live chat** to pick up
your draft where you left off. The filter searches session labels and directories,
not message bodies.

`/chat link` prints the local link without opening a browser. `/chat close` disconnects
the current browser page. `/reload` reloads extension source changes and disconnects
old pages; finish unsent drafts first, then open a new page.

After installing, use `/reload` in existing sessions to load the extension.
`pi install` adds the local package to Pi settings; it does not publish anything.
Remove it with `pi remove /path/to/pi-chat`.

If you cloned the repository under its former name, you can keep the existing
checkout and Pi installation path. To point Git at the new repository URL, run
`git remote set-url origin https://github.com/TongVu/pi-chat.git` from the checkout.

## What is implemented

- A live chat view of the active branch's user messages and text-bearing assistant
  replies. It excludes thinking and tool calls.
- Native browser text selection, a comment dialog, and multiple annotations with
  edit/remove and batch submission as a normal Pi turn.
- Headings, bold/italic text, lists, blockquotes, links, and code blocks rendered
  locally from Markdown in sent messages, annotation questions, and Pi replies.
- Exact quote offsets validated against server-generated rendered text, plus the
  source response's session entry ID in each submitted annotation.
- Independent browser message and annotation drafts, duplicate-send protection,
  and retry after a busy-agent or connection failure.
- Invalidation on session switches, forks, tree navigation, shutdown, or
  replacement by another `/chat` page.

Selections refer to the **rendered text**, not Markdown punctuation. The server
renders once and derives canonical text with an HTML5 parser; the browser checks
that its DOM text matches before allowing annotations. Quotes can cross formatting,
paragraphs, and code lines without mapping back to Markdown-source offsets.

Raw HTML stays literal, images become selectable descriptions without resource
URLs, and only explicit HTTP(S) links are clickable (in a separate tab). Code is
formatted but not syntax-highlighted. Native selection and the comment field do
not require clipboard access or access to Pi's private transcript selection.

## Privacy and lifetime

- The server binds to `127.0.0.1` on a random port, not the network interface.
- Chat APIs require a random per-window bearer token. The opening
  link carries it in a URL fragment; the page removes the fragment from the address
  bar/history after reading it. Do not share the link.
- Host and Origin checks prevent cross-origin/rebinding requests. No CORS, external
  assets, or third-party services are used by the browser pages. A CSP
  blocks external resources and embedding. Markdown parsing uses local `marked`
  and `parse5` dependencies; no CDN is contacted. Only generated Markdown HTML is
  inserted into the page; original raw HTML and comments are never inserted as
  active markup. Links make no request unless you choose to open them.
- This is a local authenticated capability, not protection against a compromised
  OS, browser, or extension. Response text can contain private data: use a trusted
  browser/profile. `/chat link` lets you choose where to open the local chat.
- A connected `/chat` tab keeps its port open by polling. The page asks Pi to close
  the port when you leave. If the browser crashes, is suspended, or can't send
  that request, Pi closes the port after 30 minutes without a poll.
- The extension keeps no separate transcript or message drafts on disk; the
  reusable Markdown note is stored locally per Pi session. Closing/reloading the
  page loses unsent drafts and reloading discards the access token. Reopen from Pi.
- Chat mode shows visible user and assistant text and supported user images from
  the active branch, including older messages. It does not show system prompts,
  hidden reasoning, or tool calls/results. The local page fetches each visible
  thumbnail separately with the chat token. Text and images can be sensitive.
- Opening **Chats** lists saved session labels and project directories from Pi's
  local session store and the current session's custom store, if any. The chat
  token also protects these reads. Selecting a saved session reads its last
  persisted branch without modifying the session file or switching Pi's session.
  **Resume in browser** is a separate, authenticated action that only launches
  already-listed sessions. Open `/chat` tabs are detected through local presence
  markers under the Pi agent directory. A private local Unix socket lets a running
  Pi session open its own browser tab. Live markers hold status and a random,
  non-secret loopback tab locator, never a bearer token. The locator is not returned
  to dashboard or chat pages. On macOS, the user-triggered **Go to tab** action uses
  the browser's native Automation support to select an exact matching tab; it
  never navigates or reloads that tab.
- The dashboard uses a separate bearer token and shows local session names, first
  message previews, project directories, and statuses. Its API doesn't expose
  full transcripts or accept messages for Pi.
- Selected files are sent to Pi only when you send the message. Pi receives text
  files inline with their names and images as normal image inputs.
- Opening a local chat page does not modify Pi's MCP/browser allowlist or
  authorize browser automation at any additional origin.

## Development

From this repository root:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

The host supplies the Pi peer dependency. `--legacy-peer-deps` avoids downloading
another Pi installation just to run the tests.

Local source helpers use `.ts` so Pi's extension loader can reload them. On this
Pi 1.3.0 / Node.js 26.5.0 setup, native `.mjs` helpers stayed cached across reloads,
leaving old server code paired with new browser assets. Do not change those helpers
back to `.mjs` without verifying same-process reload behavior.

The native-loader regression test runs automatically inside the managed Pi
environment. Elsewhere, set `PI_EXTENSION_LOADER` to your installed Pi's
`dist/core/extensions/loader.js` to run it; without that path it is explicitly skipped.

Tests cover quote/offset validation, browser composer drafts, real loopback HTTP
requests, authentication/origin/host restrictions, lifecycle
invalidation, duplicate/retry behavior, mocked Pi commands, Markdown rendering,
HTML/link/image safety, and jsdom browser interactions across formatted text,
paragraphs, lists, entities, emoji, and code blocks. They do not prove native
selection or visual layout in a real browser.

### Verification so far

- The installed Pi native extension loader has been used to exercise local chat
  reload and browser-server behavior.
- No model request or browser UI control was used for these checks.
- `npm audit` reported zero vulnerabilities after the Markdown dependencies were installed.
- The user reported a rendered-text failure after `/reload`. A reproduction showed
  native `.mjs` helper caching across reloads; changing local helpers to `.ts` passed
  same-process reload and rendered-text regression checks.
- Live browser acceptance of the reload fix and rendered selection is still needed.
  Other OS browser launchers have not been live-tested.

### Manual acceptance

Run `/chat`. Use Shift+Enter to create a newline and Enter to send. Check that the
reply appears in the same tab. Scroll a long transcript and check that the dots
stay centered, highlight the current turn, and jump to earlier messages. Attach
several text files and screenshots and check that Pi receives all of them. Send an
annotation batch and check that the right panel clears. Try a narrow browser
window and check that closing the tab disconnects its link. Real keyboard
selection support depends on browser caret browsing.

For the dashboard, open two chats and leave an unsent draft in one. Run
`/chat dashboard`, send from the other chat, and check that its dot pulses and
then turns green. Use **Go to tab** and verify the existing draft is unchanged.
Close that chat tab, then use **Reopen chat** from the dashboard and check that
Pi opens a fresh tab without starting another terminal session.
