import test from "node:test";
import assert from "node:assert/strict";
import { bubblewrapReadOnlyArgs } from "../../src/agent/read-only-sandbox.js";

test("read-only shell commands get a read-only root, private /tmp, and the original cwd", () => {
  const args = bubblewrapReadOnlyArgs("journalctl -u demo --no-pager", "/srv/app", "/bin/bash");
  assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
  assert.ok(args.includes("--tmpfs"));
  assert.ok(args.includes("--unshare-pid"));
  assert.ok(args.includes("--die-with-parent"));
  assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", "/srv/app"]);
  assert.deepEqual(args.slice(-4), ["--", "/bin/bash", "-c", "journalctl -u demo --no-pager"]);
});

test("the command remains one argv entry, so quoting cannot escape the sandbox wrapper", () => {
  const command = "printf '%s\\n' \"$(whoami)\" > /tmp/out";
  const args = bubblewrapReadOnlyArgs(command, "/work", "/bin/bash");
  assert.equal(args.at(-1), command);
  assert.equal(args.filter((arg) => arg === command).length, 1);
});
