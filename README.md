# Pi Annotate

A local Pi extension for asking questions about passages in an assistant response.
Select text in a browser page, add comments, then return the batch to Pi's **draft
editor**. You decide when to press Enter. No model call is made by this extension.

## Try it

Requires Pi 1.3.0 and Node.js 22.19+. There is no build step. From this repository
root, install the local Markdown-rendering dependencies once:

```sh
npm ci --omit=dev --ignore-scripts --legacy-peer-deps
```

Then exit Pi and run this **from the project whose chat you want to continue**:

```sh
pi --continue --extension /Users/tongvu/Projects/pi-annotate/src/index.ts
```

Use your checkout's absolute path on other machines. Do not change into the
`pi-annotate` directory just to resume a different project's chat; Pi groups
sessions by working directory. Both regular and fullscreen terminal modes work.

1. Run `/annotate` after the assistant finishes responding. It opens a local page
   in your default browser. Nothing opens merely from loading the extension.
2. Select a passage in the response. A question/comment dialog appears.
3. Enter your question and click **Add annotation**. Repeat for more passages.
4. Edit or remove annotations in the side panel as needed.
5. Click **Add to Pi draft** once. Switch back to Pi.
6. Review the quotes and questions appended to your input, then press Enter to send.

Existing input is preserved: annotations append to the draft as it exists at
transfer time, including changes you made while the annotation page was open.
There is no automatic model submission. The browser tab stays open so you can see
whether transfer succeeded; close it when done.

Other commands:

- `/annotate link` — show a local link without opening the browser.
- `/annotate close` — disconnect the current annotation page.
- `/reload` — reload extension source changes; old annotation pages are disconnected.
  Finish unsent annotations first, then run `/annotate` to open a new page.

To load it in future chats, optionally install this local package yourself:

```sh
pi install /Users/tongvu/Projects/pi-annotate
```

Then use `/reload` in an existing session. Installation adds the local package to
Pi settings; it does not publish anything. Remove it with
`pi remove /Users/tongvu/Projects/pi-annotate`.

## What is implemented

- The latest text-bearing assistant message on the active branch, excluding
  thinking and tool calls.
- Native browser text selection, a comment dialog, multiple annotations,
  edit/remove, and batch return to Pi.
- Headings, bold/italic text, lists, blockquotes, links, and code blocks rendered
  locally from Markdown.
- Exact quote offsets validated against server-generated rendered text, plus the
  original response's session entry ID in the returned draft.
- Current-draft preservation, duplicate-transfer protection, and retry after a
  busy-agent or connection failure.
- Mode checks and invalidation on session switches, forks, tree navigation,
  shutdown, replacement by another `/annotate`, or a 30-minute timeout.

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
- Response and transfer APIs require a random per-window bearer token. The opening
  link carries it in a URL fragment; the page removes the fragment from the address
  bar/history after reading it. Do not share the link.
- Host and Origin checks prevent cross-origin/rebinding requests. No CORS, external
  assets, uploads, browser automation, or third-party services are used. A CSP
  blocks external resources and embedding. Markdown parsing uses local `marked`
  and `parse5` dependencies; no CDN is contacted. Only generated Markdown HTML is
  inserted into the page; original raw HTML and comments are never inserted as
  active markup. Links make no request unless you choose to open them.
- This is a local authenticated capability, not protection against a compromised
  OS, browser, or extension. Response text can contain private data: use a trusted
  browser/profile. `/annotate` uses the OS default browser; `/annotate link` lets
  you choose where to open it.
- Response text and browser annotations remain in memory. There is no autosave,
  storage in localStorage, or session-file modification. Closing/reloading the
  browser page loses unsent annotations. Reloading also loses the page's access
  token: use `/annotate` again.
- Returned questions enter the normal chat/session only when **you submit** the
  Pi draft. No full conversation history, hidden reasoning, credentials, or files
  are sent to the browser.
- Opening a local annotation page does not modify Pi's MCP/browser allowlist or
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

Tests cover response extraction, quote/offset validation, draft preservation,
real loopback HTTP requests, authentication/origin/host restrictions, lifecycle
invalidation, duplicate/retry behavior, mocked Pi commands, Markdown rendering,
HTML/link/image safety, and jsdom browser interactions across formatted text,
paragraphs, lists, entities, emoji, and code blocks. They do not prove native
selection or visual layout in a real browser.

### Verification so far

- All 30 tests passed with Node.js 26.5.0 on this Mac, including a same-process
  reload test through the installed Pi 1.3.0 loader and a stale-server UI test.
- The installed Pi 1.3.0 native extension loader loaded `src/index.ts`, registered
  `/annotate`, and served its local page through `/annotate link` with no errors.
- No model request or browser UI control was used for these checks.
- `npm audit` reported zero vulnerabilities after the Markdown dependencies were installed.
- The user reported a rendered-text failure after `/reload`. A reproduction showed
  native `.mjs` helper caching across reloads; changing local helpers to `.ts` passed
  same-process reload and rendered-quote transfer regression checks. The browser now
  distinguishes a stale server from a genuine rendered-text mismatch.
- Live browser acceptance of the reload fix and rendered selection is still needed.
  Other OS browser launchers have not been live-tested.

### Manual acceptance

1. Load the extension and resume the intended chat. Run `/annotate`.
2. Confirm only the latest assistant text appears, with rendered headings/bold/lists
   and code blocks, and no hidden reasoning. Images should be descriptions, not loads.
3. Select across bold/link boundaries, paragraphs, and code lines; check that the
   comment dialog quotes that passage without Markdown markers. Add two comments.
4. Edit one, remove the other, and add another. Cancel a selection too.
5. Type an extra draft in Pi while keeping the annotation tab open.
6. Click **Add to Pi draft**. Confirm the existing draft remains and the ordered
   questions appear once. Confirm no model turn starts automatically.
7. Submit from Pi only when ready.
8. Run `/annotate` again, then `/annotate close`; confirm the old page can no longer
   transfer. Repeat around a session/tree switch if needed.
9. Check narrow-window layout, emoji/non-ASCII quotes, long selections, and a failed
   transfer/retry. Real keyboard selection support depends on browser caret browsing.
