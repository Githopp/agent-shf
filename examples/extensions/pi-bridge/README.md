# pi-bridge

Runs [pi](https://github.com/earendil-works/pi-mono) (`@earendil-works/pi-coding-agent`) as an agent-sh backend. Pi brings its own configuration, models, tools, and extensions — agent-sh just provides the terminal.

Targets pi SDK **1.x** under the `@earendil-works` scope (the old `@mariozechner/pi-*` 0.66 packages still resolve but are deprecated).

## Install (NixOS)

The agent-sh flake builds this extension as a prebuilt store package:

```bash
nix build .#pi-bridge
```

The output is the complete extension tree — `package.json`, `index.ts`, and a fully-resolved `node_modules` — so it can be symlinked read-only into `~/.agent-sh/extensions/`: agent-sh's loader follows symlinked extension dirs and nothing installs at load time. On hosts managed with hjem:

```nix
".agent-sh/extensions/pi-bridge".source =
  "${inputs.agent-shf.packages.${pkgs.system}.pi-bridge}";
```

Dependency changes need the standalone lock regenerated OUTSIDE the repo workspace (see `nix/pi-bridge.nix` for the recipe), a new `npmDepsHash` (`nix build .#pi-bridge` reports it), and a rebuild.

## Install (npm)

```bash
agent-sh install pi-bridge
```

This copies the bundled extension into `~/.agent-sh/extensions/pi-bridge` and runs `npm install`. To overwrite an existing install, pass `--force`. To uninstall, run `agent-sh uninstall pi-bridge`.

## Configure

Set as default backend in `~/.agent-sh/settings.json`:

```json
{
  "defaultBackend": "pi"
}
```

Or switch at runtime:

```
> /backend pi
```

Pi reads its own settings from `~/.pi/agent/settings.json`. Configure API keys and model preferences there (or run `pi` directly to set up auth) — agent-sh does not override pi's configuration.

## What works under pi

These slash commands are routed to pi's SDK when pi is the active backend:

- `/model` — lists/switches pi's available models (`modelRuntime.getAvailable`, `session.setModel`)
- `/thinking` — sets pi's thinking level (`off/minimal/low/medium/high/xhigh/max`)
- `/compact` — runs `session.compact()` on pi's session
- `/context` — reports pi's token usage (`session.getContextUsage()`)

Submits while pi is still streaming queue via `session.followUp()`; `/reset` maps to `runtime.newSession()` with subscriptions rebound to the new session.

agent-sh's per-query context producers (e.g. `<shell_events>` from `shell-context`) are inlined into pi's prompt before each query, so pi sees the user's recent shell activity even though it doesn't subscribe to agent-sh's shell bus directly.

## What this bridge is

A pure protocol translator between pi's event stream and agent-sh's bus events. Pi's built-in tools (command execution, file ops, etc.) are used exactly as pi ships them. The bridge adds no tools of its own.
