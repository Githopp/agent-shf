import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../../src/core/event-bus.js";
import { registerAgentModes, resolveAgentModes } from "../../src/shell/agent-modes.js";
import type { InputModeConfig } from "../../src/shell/host-types.js";

function captureModes() {
  const bus = new EventBus();
  const modes: InputModeConfig[] = [];
  const switches: Array<{ id: string; provider: string; persist?: boolean }> = [];
  const submits: Array<{ query: string; readOnly?: boolean }> = [];
  bus.on("input-mode:register", (mode) => modes.push(mode));
  bus.on("config:switch-model", (event) => switches.push(event));
  bus.on("agent:submit", (event) => submits.push(event));
  return { bus, modes, switches, submits };
}

test("no agentModes setting keeps the historical single > mode", () => {
  const modes = resolveAgentModes({});
  assert.deepEqual(modes.map((mode) => mode.trigger), [">"]);
  assert.equal(modes[0]!.promptIcon, "❯");
});

test("extra triggers are added while > stays available unless explicitly disabled", () => {
  const modes = resolveAgentModes({
    agentModes: {
      '"': { provider: "zai", model: "glm" },
      "'": { provider: "deepseek", model: "deepseek-chat" },
    },
  });
  assert.deepEqual(modes.map((mode) => mode.trigger), [">", '"', "'"]);
  assert.equal(modes.find((mode) => mode.trigger === '"')!.promptIcon, '"');

  const disabled = resolveAgentModes({ agentModes: { ">": false, "?": { readOnly: true } } });
  assert.deepEqual(disabled.map((mode) => mode.trigger), ["?"]);
  assert.equal(disabled[0]!.readOnly, true);
});

test("agentModes entries register input modes, switch models without persisting, and mark read-only runs", () => {
  const h = captureModes();
  registerAgentModes(h.bus, resolveAgentModes({
    agentModes: {
      '"': { provider: "zai", model: "glm" },
      "?": { provider: "deepseek", model: "deepseek-chat", readOnly: true },
    },
  }));

  assert.deepEqual(h.modes.map((mode) => mode.trigger), [">", '"', "?"]);
  assert.equal(h.modes.find((mode) => mode.trigger === ">")!.id, "agent");

  h.modes.find((mode) => mode.trigger === '"')!.onSubmit("use glm", h.bus);
  assert.deepEqual(h.switches, [{ id: "glm", provider: "zai", persist: false }]);
  assert.deepEqual(h.submits, [{ query: "use glm" }]);

  h.modes.find((mode) => mode.trigger === "?")!.onSubmit("why did it fail", h.bus);
  assert.deepEqual(h.switches[1], { id: "deepseek-chat", provider: "deepseek", persist: false });
  assert.deepEqual(h.submits[1], { query: "why did it fail", readOnly: true });
});

test("a half-configured mode warns but still submits the query", () => {
  const h = captureModes();
  const errors: string[] = [];
  h.bus.on("ui:error", ({ message }) => errors.push(message));
  registerAgentModes(h.bus, resolveAgentModes({
    agentModes: { "'": { provider: "deepseek" } },
  }));

  h.modes.find((mode) => mode.trigger === "'")!.onSubmit("hello", h.bus);
  assert.match(errors[0]!, /provider and model/);
  assert.deepEqual(h.switches, []);
  assert.deepEqual(h.submits, [{ query: "hello" }]);
});
