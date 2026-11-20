import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import { EventBus } from "../../src/core/event-bus.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";

const call = (name: string) => ({
  index: 0,
  id: `call-${name}`,
  type: "function",
  function: { name, arguments: "{}" },
});

function harness() {
  const handlers = new HandlerRegistry();
  const bus = new EventBus();
  const requests: any[] = [];
  const rounds = [
    { text: "", calls: [call("write")] },
    { text: "first answer" },
    { text: "", calls: [call("write")] },
    { text: "second answer" },
  ];
  handlers.define("cwd", () => "/tmp/read-only-test");
  handlers.define("dynamic-context:build", () => "");
  handlers.define("agent:file-read-cache", () => new Map());
  handlers.define("config:settings", () => ({ get: () => ({ toolMode: "api", autoCompact: false, thinkingLevel: "off" }) }));
  const llmClient = {
    model: "fake-model",
    async stream(request: any) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const round = rounds[requests.length - 1] ?? { text: "done" };
      return (async function* () {
        yield { choices: [{ delta: { content: round.text ?? "", tool_calls: round.calls } }] };
        yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      })();
    },
  } as unknown as LlmClient;
  const loop = new AgentLoop({ handlers, bus, llmClient, ambientContext: false });
  let writes = 0;
  loop.registerTool({
    name: "read", description: "read", input_schema: {},
    execute: async () => ({ content: "read result", exitCode: 0, isError: false }),
  });
  loop.registerTool({
    name: "write", description: "write", input_schema: {}, modifiesFiles: true,
    execute: async () => {
      writes++;
      return { content: "wrote", exitCode: 0, isError: false };
    },
  });
  loop.registerTool({
    name: "spawn_agent", description: "delegate", input_schema: {},
    execute: async () => ({ content: "delegated", exitCode: 0, isError: false }),
  });
  return { loop, requests, writes: () => writes };
}

const options = { systemPrompt: "test system", dynamicContext: "test context" };

test("read-only runs hide mutating tools, explain the restriction, and refuse a forced call", async () => {
  const { loop, requests, writes } = harness();
  const result = await loop.run("diagnose", { ...options, readOnly: true });

  const tools = (requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  assert.ok(tools.includes("read"));
  assert.ok(!tools.includes("write"));
  assert.ok(!tools.includes("spawn_agent"), "delegation would escape the read-only policy");
  assert.match(String(requests[0]!.messages[0]!.content), /# Read-only mode/);
  assert.equal(writes(), 0);

  const refused = result.messages.find((message) => message.role === "tool");
  assert.match(String(refused?.content), /Read-only mode: write is unavailable/);
  await loop.dispose();
});

test("the same tools execute normally outside read-only runs", async () => {
  const { loop, requests, writes } = harness();
  const result = await loop.run("do it", options);
  assert.equal(writes(), 1);
  assert.doesNotMatch(String(requests[0]!.messages[0]!.content), /# Read-only mode/);
  assert.equal(result.stopReason, "completed");
  await loop.dispose();
});
