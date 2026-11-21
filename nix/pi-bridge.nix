{
  lib,
  buildNpmPackage,
  nodejs_22,
  src,
}:

# Prebuilt pi-bridge extension for agent-sh: sources + npm-resolved
# node_modules in one store path, so agent-sh can load it read-only from
# ~/.agent-sh/extensions (loader follows symlinked dirs; nothing installs
# at load time because node_modules ships complete).
#
# The bundle's package-lock.json is STANDALONE (not part of the repo
# workspace) — regenerate after dependency changes with:
#   T=$(mktemp -d) && cp package.json $T/ && \
#   (cd $T && npm install --package-lock-only --no-audit --no-fund) && \
#   mv $T/package-lock.json ./
buildNpmPackage {
  pname = "agent-sh-pi-bridge";
  version =
    (builtins.fromJSON (builtins.readFile (src + "/examples/extensions/pi-bridge/package.json"))).version;

  # Flake source (git tree) carries no node_modules; the temp-dir lock
  # procedure above keeps this subtree lock-only-visible to this build.
  src = src + "/examples/extensions/pi-bridge";

  # Computed from the standalone package-lock.json; regenerate after
  # dependency changes (nix build reports the expected hash on mismatch).
  npmDepsHash = "sha256-WvQMxPyuDsKO3197oRC8rvWM8dDjUhc/ZuPRVRHkM/U=";

  nodejs = nodejs_22;

  # package.json has no build script — just resolve deps.
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall
    # The tree agent-sh loads: package.json ("type": "module") + index.ts
    # resolved by tsx at load, node_modules for the pi SDK. Read-only store
    # modes are fine — the loader never writes inside an extension.
    mkdir -p $out
    cp -r package.json package-lock.json index.ts README.md node_modules $out/
    runHook postInstall
  '';

  meta = with lib; {
    description = "pi coding agent backend for agent-sh (prebuilt extension tree)";
    license = licenses.mit;
    platforms = platforms.unix;
  };
}
