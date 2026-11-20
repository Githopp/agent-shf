import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { findBash } from "../utils/executor.js";

export interface ReadOnlySandbox {
  /** bubblewrap executable. */
  file: string;
}

let cached: ReadOnlySandbox | null | undefined;

function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (executable(p)) return p;
  }
  return undefined;
}

function findBwrap(): string | undefined {
  const candidates = [
    process.env.SBX_BWRAP,
    "/usr/bin/bwrap",
    "/usr/local/bin/bwrap",
    "/run/current-system/sw/bin/bwrap",
    onPath("bwrap"),
  ];
  for (const p of candidates) {
    if (p && executable(p)) return p;
  }
  return undefined;
}

function probe(bwrap: string): boolean {
  const r = spawnSync(bwrap, [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--unshare-pid",
    "true",
  ], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0;
}

/**
 * Probe bubblewrap once. Cached even when absent so repeated read-only tool
 * calls don't pay for a fresh probe.
 */
export function getReadOnlySandbox(): ReadOnlySandbox | null {
  if (cached !== undefined) return cached;
  const bwrap = findBwrap();
  cached = bwrap && probe(bwrap) ? { file: bwrap } : null;
  return cached;
}

/** The full argv bubblewrap needs to run one shell command with a read-only filesystem. */
export function bubblewrapReadOnlyArgs(
  command: string,
  cwd: string,
  shell: string = findBash() ?? "/bin/sh",
): string[] {
  // A private tmpfs keeps programs that need scratch space working without
  // exposing the host's /tmp to writes. If cwd itself lives under /tmp, keep
  // the host /tmp visible (read-only) so --chdir still works, and put scratch
  // files in a private subdirectory instead.
  const cwdUnderTmp = cwd === "/tmp" || cwd.startsWith("/tmp/");
  const tmpDir = cwdUnderTmp ? "/tmp/.agent-sh-readonly-tmp" : "/tmp";

  return [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", tmpDir,
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    "--setenv", "SBX_SANDBOXED", "1",
    "--setenv", "SBX_SANDBOX_KIND", "bubblewrap",
    "--setenv", "TMPDIR", tmpDir,
    "--setenv", "XDG_CACHE_HOME", `${tmpDir}/.cache`,
    "--chdir", cwd,
    "--",
    shell, "-c", command,
  ];
}
