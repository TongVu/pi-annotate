# Pi Chat guide

For installation and the first launch, see the [README](../README.md#install).
After installing the dependencies, you can try the extension without registering
it: run `pi --extension /path/to/pi-chat/src/index.ts --dashboard`, replacing
`/path/to/pi-chat` with the checkout’s absolute path. Both regular and fullscreen
terminal modes work.

## Live browser chat

1. Open or create a chat from the dashboard. To attach directly to an
   already-running Pi session, run `/chat` in its terminal, or use `/chat link`
   to open the link yourself. A named session appears by name in its browser tab.
2. Type a message in the bottom composer, or select text in a Pi reply and click
   **Add annotation** to write a question. You can also copy the selected text
   normally without opening the dialog. Keep reusable Markdown in the left sidebar's note;
   it saves locally per chat in Pi's data directory, survives closing and
   reopening `/chat`, and can be previewed or copied as Markdown. The dots stay
   centered on the left as you scroll; the current turn is blue.
   Hover over the dots to open a scrollable list with up to four lines of preview
   per message. Click a dot or list row to jump to that message. On touch, tap a
   dot to open the list; with a keyboard, focus a dot and press **Right Arrow**
   to enter the list.
3. Press **Enter** or click **💬** to send an ordinary message.
   **Shift+Enter** inserts a newline. Click **Send questions** to submit the
   annotation batch. You can paste a screenshot into an annotation's comment
   field or attach images with its clipboard button. Each question keeps its own
   images. These are separate sends: each leaves the other draft untouched and
   clears its own draft only after Pi accepts it. The terminal draft is untouched.
   While Pi is working on your browser message, click **✍️** to stop the reply
   and restore the text and attachments to the composer. Edit the draft, then
   resend once Pi is idle. The original turn stays in the transcript; stopping
   does not undo actions Pi already took.
4. New messages appear in the same tab as Pi finishes them. The composer border
   and status dot pulse amber while Pi is working unless reduced motion is set.
   The dot turns green when Pi is ready. Replies aren't streamed
   token by token. If Pi needs an approval or other interactive input, use the terminal.

Click **👾** in the composer to view or change this chat’s model and thinking effort. Type in the model field to filter Pi’s model cycle, then click a result or choose it with the arrow keys and Enter. Click any thinking level supported by the model to select it. The active level is highlighted. Changes are available when Pi is idle and do not affect defaults for new chats.

Click the **Context usage** ring in the composer to see Pi's estimated token usage and the model's context limit. Click **Compact chat** when Pi is idle and confirm to summarize older context without removing messages from the transcript. After compaction, Pi reports usage again after its next reply.

Click the live chat title to rename the session. Use the panel icons next to
**🕹️** to show or hide notes and annotations on the left or the chat explorer on the right.
On narrow screens, notes and annotations sit below the chat and the explorer opens from the right edge.
Click **🕹️** to switch to the terminal tab running that chat. It does not start
Pi, open a new tab, or send text to the terminal.
On macOS, use Terminal.app and allow Terminal Automation if prompted. On Linux,
Kitty needs a local remote-control socket. For example, in `kitty.conf`, use:

```conf
allow_remote_control socket-only
listen_on unix:${XDG_RUNTIME_DIR}/kitty-{kitty_pid}
```

Use this path only if `XDG_RUNTIME_DIR` is set to your private runtime directory.
Restart Kitty and start Pi directly in a new Kitty shell so Pi inherits the socket
address. On Wayland, the compositor may not bring Kitty in front of the browser.

Drop files onto the composer, click **Attach files** to pick them, or paste a
screenshot. Dropping a file keeps your draft intact and doesn't send it. Draft
images show a thumbnail; click it or the filename to inspect a larger preview.
Sent images can also be opened from the thumbnails in the conversation. Send
up to 10 UTF-8 text/code files or PNG, JPEG, GIF, and WebP images, with or
without a message. Limits are 5 MiB per file and 10 MiB combined. The same
image limits apply across an annotation batch.

UTF-8 build logs can contain ANSI color codes, which are removed from inline
text. If text attachments total more than 512 KiB, Pi Chat saves the original
bytes in a private `.pi-chat-attachments` directory under Pi's session storage
(or Pi's agent directory for in-memory sessions). Pi receives their
local paths instead of their contents and can search or read excerpts with its
file tools. These copies stay on disk after the chat closes so resumed chats
can still read them.
PDFs, Office documents, and archives aren't supported.
Images sent to Pi require an image-capable model and must not be blocked in Pi settings.

The sidebar note also accepts pasted screenshots and files via its paperclip,
with the same types and upload limits as the composer, plus a 128 KiB combined
limit for note text attachments. Click an image to preview it
or a text filename to download it. Attachments are saved with the note for that
session, not sent to Pi. **Copy note Markdown** still copies only the text.

Chat submissions start a normal Pi turn with the session's model and tools. They
aren't interpreted as slash commands. If a send can't be confirmed, the draft stays
in the browser; retrying the unchanged send checks the same request rather than
starting another turn. If Pi never confirms it, check the terminal and reopen the
chat before sending again. Live chat was verified with Pi 1.5.2.

## Chat dashboard

Run `pi --dashboard` from your shell. From a running Pi session, `/chat dashboard`
or the logo to the left of the chat title opens the dashboard without losing a chat draft.
On macOS, the logo switches to an existing dashboard tab in Chrome or Safari,
including one opened by another Pi using the same agent directory. If no tab
is found, or tab switching is unavailable, the logo opens a new tab. macOS may
ask for browser Automation permission.
The sidebar groups sessions by their original project directory. Select a
project and hover over its path (or Tab to **Copy project path**) to copy the
exact path for pasting into your terminal. Clones have separate cards with a
**Cloned from** line when their parent session is available.
Filter by
**Name or directory** to narrow the sidebar, cards, and counts. **All sessions**
shows every group; **Needs attention** shows connected chats that are ready for
input or whose last turn stopped. Its status counts still include all matching
chats. **Bookmarks** shows only the chats you’ve bookmarked, grouped by project.
Hover over a session card or use keyboard focus to reveal its top-right bookmark
button (always visible on touch screens). Click it again to remove the bookmark.
Bookmarks stay visible on marked cards and survive dashboard and machine restarts.
Pulsing amber and green dots mark working and ready chats, respectively.
A hollow green ring marks a Pi session still running in Terminal without a connected chat tab.
It pulses amber during a turn but stays in the **Disconnected** count. A filled gray dot
marks a saved session that isn't running. Status updates even when the chat tab is in the background.
The status legend shows **5-hour · N% left** when the local Codex CLI or the CLI
bundled with the macOS ChatGPT app reports a five-hour quota. The badge uses the
account signed into Codex, not Pi's context usage, and refreshes about once a minute.

- **🕹️ Switch to Terminal** focuses the Pi terminal hosting the dashboard, not
  the terminal for a selected chat. It supports Terminal.app on macOS and Kitty
  on Linux with local remote control enabled.
- **Go to tab** on macOS switches to the existing tab in Chrome or Safari without
  reloading it or discarding its draft. macOS may ask for Automation permission.
  On Linux, install [Pi Chat Tab Switcher](ubuntu-edge-kitty.md#dashboard-tab-switching) in Edge or Chrome for the same behavior.
  On unsupported browsers or when the tab can't be found, select it manually;
  the dashboard never opens a replacement for a connected chat.
- **Reopen chat** asks the running Pi session to open a fresh tab. It does not
  start a second Pi or interrupt an ongoing turn.
- **Resume chat** starts the saved session in its original project via Terminal
  on macOS or in a new tab in the dashboard’s Kitty window on Linux. If terminal
  launch is unavailable, copy the resume command, then run `/chat` in Pi.
- **Create new chat** asks you to choose a dashboard project, including the one
  you launched the dashboard from, even if it has no chats yet. It starts a fresh
  Pi there in Terminal on macOS or in a new tab in the dashboard’s Kitty window
  on Linux, then opens the new session’s browser chat. Existing chats and drafts
  are left alone. If terminal launch is unavailable, copy the start command, then
  run `/chat` in Pi.

The dashboard lists saved sessions in Pi's default store and this Pi's custom
store, if any, plus chats advertised by other running Pi instances using the
same agent directory. Reload older Pi instances and reopen their chat pages to
publish the new status and tab locator. The dashboard has its own local server:
`/chat close` closes only the chat tab's connection, but exiting or replacing the
Pi session that opened the dashboard (including `/reload`) closes the dashboard
server too.

## Chat explorer

Click the right-panel icon in the centered chat controls to open the explorer.
To create a session, use **Create new chat** on the dashboard. The explorer groups sessions by
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
  non-secret loopback tab locator, never a bearer token. The dashboard list omits
  locators. A Linux browser-switch request returns only the selected chat's locator
  for the extension to match; it does not return the chat token. On macOS, the user-triggered **Go to tab** action uses
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

The chat entry point `web/app.js` loads native browser modules from `web/chat/`.
There is no frontend build. When adding a module, list its URL explicitly in
`src/server.ts`. Already-open tabs keep their loaded code. After updating the
checkout, a newly opened tab from an older Pi listener may be missing module
URLs. Finish any unsent drafts, run `/reload` in Pi, then reopen `/chat`.

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
annotation batch and check that the annotations list clears. Try a narrow browser
window and check that closing the tab disconnects its link. Real keyboard
selection support depends on browser caret browsing.

For the dashboard, open two chats and leave an unsent draft in one. Run
`/chat dashboard`, send from the other chat, and check that its dot pulses and
then turns green. Use **Go to tab** and verify the existing draft is unchanged.
Close that chat tab, then use **Reopen chat** from the dashboard and check that
Pi opens a fresh tab without starting another terminal session.
