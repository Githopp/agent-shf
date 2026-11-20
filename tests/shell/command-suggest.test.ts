import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../../src/core/event-bus.js";
import { activateCommandSuggest } from "../../src/extensions/command-suggest.js";
import type { ToolDefinition } from "../../src/agent/types.js";

function host(existing?: ToolDefinition) {
  const bus = new EventBus();
  const tools: ToolDefinition[] = existing ? [existing] : [];
  const ctx = {
    bus,
    shell: {},
    agent: {
      getTools: () => tools,
      registerTool: (tool: ToolDefinition) => { tools.push(tool); },
    },
  };
  return { bus, tools, ctx };
}

test("command suggestions are queued for the shell prompt instead of run by the agent", async () => {
  const h = host();
  const queued: string[] = [];
  h.bus.on("shell:queue-command", ({ command }) => queued.push(command));
  activateCommandSuggest(h.ctx as never);

  const tool = h.tools.find((candidate) => candidate.name === "suggest_command");
  assert.ok(tool);
  const result = await tool!.execute({ command: "systemctl restart demo\n--now" }, undefined, undefined);
  assert.deepEqual(queued, ["systemctl restart demo --now"]);
  assert.match(result.content as string, /shell prompt/);

  await tool!.execute({ command: "   " }, undefined, undefined);
  assert.deepEqual(queued, ["systemctl restart demo --now", ""]);
});

test("activating twice (or alongside the example extension) does not duplicate the tool", () => {
  const existing: ToolDefinition = {
    name: "suggest_command", description: "already here", input_schema: {},
    execute: async () => ({ content: "", exitCode: 0, isError: false }),
  };
  const h = host(existing);
  activateCommandSuggest(h.ctx as never);
  assert.equal(h.tools.filter((tool) => tool.name === "suggest_command").length, 1);
});
