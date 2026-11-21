import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

function runOnce(args: string[], home: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: home, AGENT_SH_HOME: home, AGENT_SH_SKIP_SHELL_ENV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** A dependency-free extension laid out like a store-mounted bundle:
 *  world-read-only files (0444) and directories (0555), as found in a
 *  Nix-built agent-sh package's bundled examples. */
function makeReadOnlyExtension(): { ext: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-sh-roext-"));
  const ext = join(root, "ro-bundle");
  mkdirSync(ext);
  mkdirSync(join(ext, "lib"));
  writeFileSync(join(ext, "package.json"), JSON.stringify({
    name: "ro-bundle",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  writeFileSync(join(ext, "index.js"), "export default function activate() {}\n");
  writeFileSync(join(ext, "lib", "nested.js"), "export const n = 1;\n");
  // Store modes: 0555 dirs, 0444 files. (777 for the tmpdir itself so
  // rmSync cleanup always works; the source tree below gets store modes.)
  chmodSync(ext, 0o555);
  chmodSync(join(ext, "lib"), 0o555);
  chmodSync(join(ext, "package.json"), 0o444);
  chmodSync(join(ext, "index.js"), 0o444);
  chmodSync(join(ext, "lib", "nested.js"), 0o444);
  return { ext, root };
}

/** Assert every dir and file under root (and root itself) is owner-writable,
 *  and that a new directory can be created inside dirs (the npm-install
 *  EACCES failure mode). */
function assertTreeWritable(root: string): void {
  const mode = statSync(root).mode;
  assert.ok((mode & constants.S_IWUSR) !== 0,
    `owner-writable expected: ${root} (mode ${mode.toString(8)})`);
  accessSync(root, constants.W_OK);
  if (statSync(root).isDirectory()) {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      assertTreeWritable(join(root, ent.name));
    }
    const probe = join(root, ".probe");
    mkdirSync(probe);
    rmSync(probe, { recursive: true });
  }
}

test("install from a store-mode (read-only) source yields a writable target", { timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-rohome-"));
  const { ext, root } = makeReadOnlyExtension();
  try {
    const res = await runOnce(["install", `file:${ext}`], home, 50000);
    assert.equal(res.code, 0, `install failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);

    const installed = join(home, "extensions", "ro-bundle");
    assertTreeWritable(installed);
    // Content survived the copy:
    assert.match(res.stdout, /Installed: ro-bundle/);
  } finally {
    // Restore write access on the RO source fixture so rmSync works.
    chmodSync(ext, 0o755);
    chmodSync(join(ext, "lib"), 0o755);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("install single file from a read-only source is writable", { timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-rofile-"));
  const root = mkdtempSync(join(tmpdir(), "agent-sh-rosrc-"));
  const src = join(root, "single.ts");
  writeFileSync(src, "export default function activate() {}\n");
  chmodSync(src, 0o444);
  try {
    const res = await runOnce(["install", `file:${src}`], home, 50000);
    assert.equal(res.code, 0, `install failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const installed = join(home, "extensions", "single.ts");
    const mode = statSync(installed).mode;
    assert.ok((mode & constants.S_IWUSR) !== 0, `owner-writable expected: ${installed}`);
  } finally {
    chmodSync(src, 0o644);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
