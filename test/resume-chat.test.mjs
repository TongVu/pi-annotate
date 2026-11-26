import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kittyDashboardTarget, terminalForkArgs, terminalNewArgs, terminalResumeArgs } from "../src/resume-chat.ts";

test("Kitty launch targets only a direct shell with a local socket and a specific window", () => {
  const env = { KITTY_WINDOW_ID: "18", KITTY_LISTEN_ON: "unix:/run/user/1000/kitty-123" };
  assert.deepEqual(kittyDashboardTarget(env), { socket: env.KITTY_LISTEN_ON, windowId: "18" });
  for (const bad of [{ TMUX: "some" }, { STY: "some" }, { SSH_CONNECTION: "remote" }, { KITTY_WINDOW_ID: "0" }, { KITTY_LISTEN_ON: "tcp:localhost:1234" }]) {
    assert.equal(kittyDashboardTarget({ ...env, ...bad }), undefined);
  }
});

test("Kitty receives literal resume arguments and only the password file path", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-kitty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "chat's $(literal).jsonl");
  const extension = join(root, "chat extension.ts");
  await writeFile(path, "saved session");
  await writeFile(join(root, "pi"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const argsFile = join(root, "argv");
  await writeFile(join(root, "kitty"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS"\n', { mode: 0o755 });
  const password = join(root, "pi-chat-rc-pass");
  await writeFile(password, "test credential", { mode: 0o600 });
  const socket = "unix:/run/user/1000/demo";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { resumeInKitty } from ${JSON.stringify(new URL("../src/resume-chat.ts", import.meta.url).href)};
    const [cwd, path, extension, socket] = process.argv.slice(1);
    await resumeInKitty({ id: 'saved', cwd, path }, extension, cwd, { socket, windowId: '27' });
  `, root, path, extension, socket], { env: { PATH: root, KITTY_CONFIG_DIRECTORY: root, TEST_ARGS: argsFile }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(argsFile, "utf8")).trimEnd().split("\n"), ["@", "--to", socket, "--password-file", password, "--use-password", "always",
    "launch", "--type=tab", "--match", "window_id:27", "--cwd", root, "--env", `PATH=${root}`, "--env", `PI_CODING_AGENT_DIR=${root}`, "--env",
    "PI_ANNOTATE_AUTO_CHAT_SESSION=saved", "--", join(root, "pi"), "--session", path, "--extension", extension]);
});

test("review launch sends only the display name, scope and fixed request to a fresh restricted Pi", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-review-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argsFile = join(root, "argv");
  await writeFile(join(root, "pi"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(root, "kitty"), '#!/bin/sh\nprintf "%s\\0" "$@" > "$TEST_ARGS"\n', { mode: 0o755 });
  const title = "Fix '$(literal)' rerun";
  const source = new URL("../src/resume-chat.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {startVerifyChat} from ${JSON.stringify(source)}; await startVerifyChat(process.cwd(), process.argv[1], '/pkg/src/index.ts', process.argv[2], {socket:'unix:/test', windowId:'1'});`, title, root], { env: { ...process.env, PI_MANAGED_INSTALL_ROOT: '', PATH: `${root}:${process.env.PATH}`, TEST_ARGS: argsFile }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(argsFile, "utf8")).split('\0');
  for (const [key, value] of Object.entries({ '--name': `Verify: ${title}`, '--model': 'gpt-6.2-sol', '--thinking': 'medium', '--tools': 'review_repo' })) assert.equal(args[args.indexOf(key) + 1], value);
  for (const flag of ['--no-context-files', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates']) assert.ok(args.includes(flag));
  assert.equal(args.filter(a => a.includes(title)).length, 1);
  assert.ok(!args.includes('--session') && !args.includes('--fork') && args.includes('PI_ANNOTATE_AUTO_CHAT_SESSION=new'));
  assert.ok(args.some(a => a.startsWith('Independent, read-only review') && a.includes('Worktree:')));
});

test("Terminal resume command quotes paths, opts in to browser startup, and sends no prompt", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "a project's workspace");
  const path = join(root, "chat's $(not-a-command).jsonl");
  const pi = join(root, "Pi with spaces");
  const extension = join(root, "annotation's extension.ts");
  const agentDir = join(root, "Pi settings");
  await mkdir(cwd);
  await writeFile(path, "saved session");
  await writeFile(pi, `#!/bin/sh\nprintf '%s\n' "$PWD" "$PI_CODING_AGENT_DIR" "$PI_ANNOTATE_AUTO_CHAT_SESSION" "$@"\n`, { mode: 0o755 });
  const args = terminalResumeArgs({ id: "saved-id", cwd, path }, pi, extension, agentDir);
  const fork = terminalForkArgs({ cwd, path }, pi, extension, agentDir);
  assert.match(fork[2], /PI_ANNOTATE_AUTO_CHAT_SESSION=fork/);
  assert.match(fork[2], /--fork/);
  assert.match(fork[2], /--extension/);
  assert.equal(args[0], "-e");
  assert.match(args[1], /tell application "Terminal"/);
  assert.ok(!args[1].includes(path), "the AppleScript source is fixed; the shell command is an argument");
  const run = () => spawnSync("/bin/sh", ["-c", args[2]], { cwd: root, encoding: "utf8" });
  const output = run();
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(output.stdout.trimEnd().split("\n"), [cwd, agentDir, "saved-id", "--session", path, "--extension", extension]);
  const freshArgs = terminalNewArgs(cwd, pi, extension, agentDir);
  assert.equal(freshArgs[1], args[1]);
  const fresh = spawnSync("/bin/sh", ["-c", freshArgs[2]], { cwd: root, encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(fresh.stdout.trimEnd().split("\n"), [cwd, agentDir, "new", "--extension", extension],
    "a fresh launch changes directory, opts in to opening chat, and never resumes a session or sends a prompt");
  await rm(path);
  const deleted = run();
  assert.equal(deleted.status, 1);
  assert.equal(deleted.stdout, "", "a deleted session never falls through to launching Pi");
});
