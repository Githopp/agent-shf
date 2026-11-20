import test from "node:test";
import assert from "node:assert/strict";
import { chooseShell } from "../../src/cli/shell-detect.js";

test("an explicit --shell wins over the parent shell", () => {
  assert.equal(chooseShell({
    configured: "/bin/bash",
    explicit: true,
    interactive: true,
    envShell: "/bin/bash",
    parent: "/nix/store/x/bin/fish",
  }), "/bin/bash");
});

test("interactive launch prefers the actual parent shell over a stale $SHELL", () => {
  // The NixOS case: SHELL=/bin/bash, but the user is in fish.
  assert.equal(chooseShell({
    configured: "/bin/bash",
    explicit: false,
    interactive: true,
    envShell: "/bin/bash",
    parent: "/nix/store/x/bin/fish",
  }), "/nix/store/x/bin/fish");
});

test("unsupported parent processes fall back to the configured shell", () => {
  assert.equal(chooseShell({
    configured: "/bin/bash",
    explicit: false,
    interactive: true,
    envShell: "/bin/bash",
    parent: "/usr/bin/node",
  }), "/bin/bash");
});

test("non-interactive launches always use the configured shell", () => {
  assert.equal(chooseShell({
    configured: "/bin/zsh",
    explicit: false,
    interactive: false,
    envShell: "/bin/zsh",
    parent: "/bin/fish",
  }), "/bin/zsh");
});

test("no configured or environment shell falls back to /bin/bash", () => {
  assert.equal(chooseShell({ interactive: false }), "/bin/bash");
});
