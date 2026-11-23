import test from "node:test";
import assert from "node:assert/strict";
import { focusTerminal } from "../src/focus-terminal.ts";

test("Terminal.app focus matches the owning Pi process by TTY", async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    return command === "/bin/ps" ? "ttys004" : "focused";
  };
  await focusTerminal({ platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, pid: 9876, run });
  assert.deepEqual(calls[0], { command: "/bin/ps", args: ["-o", "tty=", "-p", "9876"] });
  assert.equal(calls[1].command, "/usr/bin/osascript");
  const [flag, script, tty] = calls[1].args;
  assert.equal(flag, "-e");
  assert.equal(tty, "/dev/ttys004");
  assert.match(script, /if tty of terminalTab is targetTTY/);
  assert.match(script, /set selected of terminalTab to true/);
  assert.doesNotMatch(script, /do script/);
});

test("Kitty focus uses the inherited Unix socket and the exact window ID", async () => {
  const calls = [];
  const env = { KITTY_WINDOW_ID: "27", KITTY_LISTEN_ON: "unix:/run/user/1000/kitty-123" };
  await focusTerminal({ platform: "linux", env, run: async (command, args) => {
    calls.push([command, args]);
    if (command === "kitten") throw Object.assign(new Error("Not installed"), { code: "ENOENT" });
    return "";
  } });
  const args = ["@", "--to", env.KITTY_LISTEN_ON, "focus-window", "--match", "id:27"];
  assert.deepEqual(calls, [["kitten", args], ["kitty", args]]);
});

test("missing or ambiguous terminal targets never run a focus command", async () => {
  const run = async () => assert.fail("must have a safe local target");
  await assert.rejects(focusTerminal({ platform: "linux", env: { KITTY_WINDOW_ID: "27" }, run }), /local remote-control socket/);
  await assert.rejects(focusTerminal({ platform: "linux", env: { KITTY_WINDOW_ID: "27", KITTY_LISTEN_ON: "tcp:localhost:9999" }, run }), /local remote-control socket/);
  await assert.rejects(focusTerminal({ platform: "linux", env: { TMUX: "active", KITTY_WINDOW_ID: "27" }, run }), /not inside tmux or screen/);
  await assert.rejects(focusTerminal({ platform: "darwin", env: {}, run }), /Terminal.app on macOS and Kitty on Linux/);
  const noTTY = async (command) => { assert.equal(command, "/bin/ps"); return "??"; };
  await assert.rejects(focusTerminal({ platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, run: noTTY }), /no Terminal.app tab/);
});
