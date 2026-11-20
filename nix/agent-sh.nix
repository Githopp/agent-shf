{
  lib,
  stdenv,
  buildNpmPackage,
  makeWrapper,
  nodejs_22,
  bash,
  ripgrep,
  src,
}:

let
  # Build-relevant sources only: drop VCS metadata, local build trees, and
  # binary demo assets — everything else (src, docs, examples/extensions)
  # ships with the package per package.json `files`.
  cleanedSrc = lib.cleanSourceWith {
    inherit src;
    filter =
      name: type:
      let
        base = baseNameOf name;
      in
      !lib.elem base [
        ".git"
        ".github"
        "node_modules"
        "dist"
        "assets"
        "tests"
        ".envrc"
      ]
      && !lib.hasSuffix ".png" name
      && !lib.hasSuffix ".gif" name
      && !lib.hasSuffix ".tsbuildinfo" name;
  };
in
buildNpmPackage {
  pname = "agent-sh";
  version = (builtins.fromJSON (builtins.readFile "${cleanedSrc}/package.json")).version;

  src = cleanedSrc;

  # Computed from the workspaces-stripped package.json (see postPatch);
  # regenerate with:
  #   node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json"));delete p.workspaces;fs.writeFileSync("package.json",JSON.stringify(p,null,2))'
  #   npm install --package-lock-only --ignore-scripts
  npmDepsHash = "sha256-UCARJgtiXoEHSyT5gxJW63JKhMro4LGsEgtj3VFSISA=";

  nodejs = nodejs_22;

  # @vscode/ripgrep's postinstall downloads a prebuilt rg binary — impossible
  # in a sandboxed build. resolveRgPath() falls back to `rg` on PATH, which
  # the wrapper below provides. node-pty ships prebuilt pty.node per platform
  # (and its loader prefers them), so skipping install scripts is safe.
  npmFlags = [ "--ignore-scripts" ];
  npmInstallFlags = [ "--ignore-scripts" ]; # global install re-runs dep postinstalls otherwise

  postPatch = ''
    # Packaging builds the CLI only; workspace members are example extensions
    # with their own dependency graphs. package-lock.json was generated from
    # the workspaces-stripped package.json, so `npm ci` stays in sync.
    # (Plain sed: the npm-deps fetcher sandbox has no node/jq/python.)
    sed -i '/"workspaces": \[/,+2d' package.json
    if grep -q '"workspaces"' package.json; then
      echo "postPatch: failed to strip workspaces from package.json" >&2
      exit 1
    fi
  '';

  nativeBuildInputs = [ makeWrapper ];

  # runtime PATH: rg for the grep/glob tools, bash for the bash tool
  # (findBash() probes canonical locations, then PATH), node for the CLI
  # itself in case npm left the `env node` shebang in place.
  postFixup = ''
    wrapProgram "$out/bin/agent-sh" \
      --prefix PATH : "${lib.makeBinPath [ ripgrep bash nodejs_22 ]}"
  '';

  meta = with lib; {
    description = "A composable agent runtime — pair any frontend with any agent backend over one shared extension layer";
    homepage = "https://github.com/guanyilun/agent-sh";
    license = licenses.mit;
    mainProgram = "agent-sh";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ]; # node-pty prebuilds
  };
}
