import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pickStrategy } from "../shell/strategies/index.js";

/**
 * Resolve which shell agent-sh should spawn.
 *
 * `$SHELL` describes the user's login shell, not necessarily the shell they
 * launched us from (NixOS, for example, keeps `SHELL=/bin/bash` while an
 * interactive session may be fish). When no `--shell` was given, prefer the
 * actual parent shell if it is one we support; otherwise fall back to `$SHELL`.
 */
export function chooseShell(opts: {
  /** Value parsed from --shell, or $SHELL as the CLI's default. */
  configured?: string;
  /** True when --shell was explicitly passed. */
  explicit?: boolean;
  /** Interactive launch (the PTY frontend will spawn this shell). */
  interactive: boolean;
  envShell?: string;
  /** Parent process command/path, when known. */
  parent?: string;
}): string {
  const { configured, explicit, interactive, envShell, parent } = opts;
  if (explicit && configured) return configured;

  if (interactive && parent) {
    const base = path.basename(parent);
    if (pickStrategy(base)) return parent;
  }

  return configured || envShell || "/bin/bash";
}

/** Best-effort parent process command/path. */
export function detectParentShell(ppid: number = process.ppid): string | undefined {
  if (!ppid || ppid <= 1) return undefined;

  if (process.platform === "linux") {
    try {
      const exe = fs.readlinkSync(`/proc/${ppid}/exe`);
      if (fs.existsSync(exe)) return exe;
    } catch {
      // Fall through to comm (e.g. /proc mounted with restrictions).
    }
    try {
      const comm = fs.readFileSync(`/proc/${ppid}/comm`, "utf-8").trim();
      if (comm) return comm;
    } catch {
      // No procfs.
    }
    return undefined;
  }

  if (process.platform === "darwin" || process.platform.includes("bsd")) {
    const r = spawnSync("ps", ["-p", String(ppid), "-o", "comm="], { encoding: "utf-8" });
    if (r.status === 0) {
      const cmd = r.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (cmd) return cmd;
    }
  }

  return undefined;
}

export function resolveShellPath(opts: {
  configured?: string;
  explicit?: boolean;
  interactive: boolean;
  env?: NodeJS.ProcessEnv;
  ppid?: number;
}): string {
  const env = opts.env ?? process.env;
  const parent = opts.interactive ? detectParentShell(opts.ppid) : undefined;
  return chooseShell({
    configured: opts.configured,
    explicit: opts.explicit,
    interactive: opts.interactive,
    envShell: env.SHELL,
    parent,
  });
}
