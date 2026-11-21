/**
 * Pi bridge — runs pi's full coding agent in-process as agent-sh's backend.
 * Pure protocol translator between pi's event stream and agent-sh's bus.
 *
 * Targets @earendil-works/pi-* v1.x (the renamed/rescoped pi packages):
 *  - createAgentSessionServices/createAgentSessionFromServices/createAgentSessionRuntime
 *    + getAgentDir (runtime needs an explicit agentDir)
 *  - modelRegistry → modelRuntime; getAvailable() is async, getModel(provider, id)
 *  - session.bindExtensions({}) once per session (and re-subscribe after newSession)
 *  - prompt() during a run rejects: mid-run submits queue via followUp()
 *  - agent_end fires per agent run; agent_settled fires once the queue/retries
 *    drain — response text ends at agent_end, the spinner ends at agent_settled
 *
 * Setup:
 *   npm install @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent
 *
 * Usage:
 *   agent-sh -e examples/extensions/pi-bridge
 */
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "agent-sh/types";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { diffLines } from "diff";

const TOOL_KINDS: Record<string, string> = {
  bash: "execute",
  read: "read",
  ls: "read",
  find: "read",
  grep: "search",
  edit: "execute",
  write: "execute",
};
const kindForTool = (name: string): string => TOOL_KINDS[name] ?? "execute";

type DiffLineRecord = { type: "context" | "added" | "removed"; oldNo: number | null; newNo: number | null; text: string };
type DiffHunkRecord = { lines: DiffLineRecord[] };
type DiffResultRecord = { hunks: DiffHunkRecord[]; added: number; removed: number; isIdentical: boolean; isNewFile: boolean };

function buildDiffFromTexts(oldText: string, newText: string, isNewFile: boolean): DiffResultRecord | null {
  if (oldText === newText) return null;
  const changes = diffLines(oldText, newText);
  const allLines: DiffLineRecord[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const lines = change.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (change.added) {
        newNo++;
        allLines.push({ type: "added", oldNo: null, newNo, text });
        added++;
      } else if (change.removed) {
        oldNo++;
        allLines.push({ type: "removed", oldNo, newNo: null, text });
        removed++;
      } else {
        oldNo++;
        newNo++;
        allLines.push({ type: "context", oldNo, newNo, text });
      }
    }
  }
  if (allLines.length === 0) return null;
  return {
    hunks: [{ lines: allLines }],
    added,
    removed,
    isIdentical: false,
    isNewFile,
  };
}

// Pi's edit returns a custom diff string: prefix(+/-/space) + lineNum + " " + text, "..." between hunks.
function parsePiDiff(raw: unknown): DiffResultRecord | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const hunks: DiffHunkRecord[] = [];
  let current: DiffLineRecord[] = [];
  let added = 0;
  let removed = 0;
  let hasOriginal = false;
  let delta = 0;

  const flush = () => {
    if (current.length > 0) hunks.push({ lines: current });
    current = [];
  };

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const prefix = line[0];
    const rest = line.slice(1);
    if (prefix === " " && rest.trim() === "...") { flush(); continue; }
    const m = rest.match(/^\s*(\d+)\s(.*)$/);
    if (!m) continue;
    const num = parseInt(m[1]!, 10);
    const text = m[2]!;
    if (prefix === "+") {
      current.push({ type: "added", oldNo: null, newNo: num, text });
      added++;
      delta++;
    } else if (prefix === "-") {
      current.push({ type: "removed", oldNo: num, newNo: null, text });
      removed++;
      delta--;
      hasOriginal = true;
    } else if (prefix === " ") {
      current.push({ type: "context", oldNo: num, newNo: num + delta, text });
      hasOriginal = true;
    }
  }
  flush();

  if (hunks.length === 0) return null;
  return { hunks, added, removed, isIdentical: added + removed === 0, isNewFile: !hasOriginal };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, call } = ctx;
  const cwd = process.cwd();

  let session: any = null;
  let runtime: any = null;
  let modelRuntime: any = null;
  let booting = true;

  // ThinkingLevel's TS schema is minimal|low|medium|high|xhigh|max, but session
  // persistence treats "off" (no thinking) as the default state and accepts it
  // at runtime — pi's own persisted session context uses exactly that value.
  const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

  // Pi's tool_execution_end omits `args` — cache from start so the end handler can use the path.
  const pendingArgs = new Map<string, any>();
  // Snapshot disk content before pi writes; diffed against args.content at end.
  const pendingWriteSnapshot = new Map<string, { oldContent: string; isNewFile: boolean }>();

  let fullResponseText = "";
  // Between agent_start and agent_settled the session cannot take a fresh
  // prompt() — mid-run submits queue via followUp() instead.
  let busy = false;
  let unsubscribe: (() => void) | undefined;

  const handleEvent = (event: AgentSessionEvent): void => {
    switch (event.type) {
      case "agent_start":
        busy = true;
        fullResponseText = "";
        break;

      case "message_update": {
        const ame = (event as any).assistantMessageEvent;
        if (ame.type === "text_delta") {
          bus.emitTransform("agent:response-chunk", {
            blocks: [{ type: "text" as const, text: ame.delta }],
          });
          fullResponseText += ame.delta;
        } else if (ame.type === "thinking_delta") {
          bus.emit("agent:thinking-chunk", { text: ame.delta });
        }
        break;
      }

      case "message_end": {
        // Synthesize agent:tool-batch so tui-renderer groups parallel tool calls under one header.
        const msg = (event as any).message;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const groupMap = new Map<string, Array<{ name: string }>>();
          for (const block of msg.content) {
            if (block?.type === "toolCall" && typeof block.name === "string") {
              const kind = kindForTool(block.name);
              if (!groupMap.has(kind)) groupMap.set(kind, []);
              groupMap.get(kind)!.push({ name: block.name });
            }
          }
          if (groupMap.size > 0) {
            const groups = Array.from(groupMap.entries()).map(([kind, tools]) => ({ kind, tools }));
            bus.emit("agent:tool-batch", { groups });
          }
        }
        break;
      }

      case "tool_execution_start": {
        const ev = event as any;
        if (ev.toolCallId) pendingArgs.set(ev.toolCallId, ev.args);
        if (ev.toolName === "write" && ev.toolCallId && typeof ev.args?.path === "string") {
          const abs = resolvePath(cwd, ev.args.path);
          let oldContent = "";
          let isNewFile = true;
          if (existsSync(abs)) {
            try { oldContent = readFileSync(abs, "utf8"); isNewFile = false; } catch {}
          }
          pendingWriteSnapshot.set(ev.toolCallId, { oldContent, isNewFile });
        }
        bus.emit("agent:tool-started", {
          title: ev.toolName,
          name: ev.toolName,
          toolCallId: ev.toolCallId,
          kind: kindForTool(ev.toolName),
          rawInput: ev.args,
        });
        break;
      }

      case "tool_execution_update": {
        const pr = (event as any).partialResult as
          | { content?: Array<{ type: string; text?: string }> }
          | undefined;
        if (pr?.content) {
          for (const c of pr.content) {
            if (c.type === "text" && c.text) {
              bus.emit("agent:tool-output-chunk", { chunk: c.text });
            }
          }
        }
        break;
      }

      case "tool_execution_end": {
        const ev = event as any;
        const args = ev.toolCallId ? pendingArgs.get(ev.toolCallId) : undefined;
        if (ev.toolCallId) pendingArgs.delete(ev.toolCallId);
        let resultDisplay: { body?: { kind: "diff"; diff: unknown; filePath: string } } | undefined;
        if (ev.toolName === "edit" && typeof args?.path === "string") {
          const rawDiff = ev.result?.details?.diff;
          const parsed = parsePiDiff(rawDiff);
          if (parsed) {
            resultDisplay = {
              body: { kind: "diff", diff: parsed, filePath: args.path },
            };
          }
        } else if (ev.toolName === "write" && typeof args?.path === "string" && !ev.isError) {
          const snap = ev.toolCallId ? pendingWriteSnapshot.get(ev.toolCallId) : undefined;
          if (ev.toolCallId) pendingWriteSnapshot.delete(ev.toolCallId);
          if (snap) {
            const newContent = typeof args.content === "string" ? args.content : "";
            const built = buildDiffFromTexts(snap.oldContent, newContent, snap.isNewFile);
            if (built) {
              resultDisplay = {
                body: { kind: "diff", diff: built, filePath: args.path },
              };
            }
          }
        }
        bus.emit("agent:tool-completed", {
          toolCallId: ev.toolCallId,
          exitCode: ev.isError ? 1 : 0,
          kind: kindForTool(ev.toolName),
          rawOutput: ev.result,
          resultDisplay,
        });
        break;
      }

      case "agent_end":
        // The low-level run finished (its text is complete); queued or
        // self-recovering work may still follow — processing-done waits.
        bus.emitTransform("agent:response-done", {
          response: fullResponseText,
        });
        break;

      case "agent_settled":
        // Nothing will continue automatically: this submit (and anything
        // queued behind it) is done.
        busy = false;
        bus.emit("agent:processing-done", {});
        break;
    }
  };

  // Subscriptions belong to one AgentSession — rebind whenever the runtime
  // replaces it (newSession/switchSession/fork), and bind extensions
  // (session_start wiring, e.g. MCP servers) per session.
  const bindSession = async (): Promise<void> => {
    unsubscribe?.();
    unsubscribe = undefined;
    session = runtime?.session;
    if (!session) return;
    await session.bindExtensions({});
    unsubscribe = session.subscribe(handleEvent);
  };

  const boot = async () => {
    try {
      const services = await createAgentSessionServices({ cwd });
      modelRuntime = services.modelRuntime;
      const sessionManager = SessionManager.inMemory(cwd);

      const createRuntime = async (opts: any) => {
        const result = await createAgentSessionFromServices({
          services,
          sessionManager: opts.sessionManager ?? sessionManager,
          sessionStartEvent: opts.sessionStartEvent,
        });
        return { ...result, services, diagnostics: services.diagnostics };
      };

      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir: getAgentDir(),
        sessionManager,
      });
      await bindSession();

      booting = false;
      const m = session?.model;
      bus.emit("agent:info", {
        name: "pi",
        version: "1.6",
        model: m ? `${m.provider}/${m.id}` : undefined,
      });
    } catch (err) {
      booting = false;
      bus.emit("ui:error", {
        message: `pi-bridge: failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  type ListenerEntry =
    | { kind: "on"; event: string; fn: Function }
    | { kind: "pipe"; event: string; fn: Function };
  const listeners: ListenerEntry[] = [];

  const wireListeners = () => {
    const onSubmit = async ({ query }: any) => {
      if (!session) {
        bus.emit("agent:error", {
          message: booting ? "pi is still starting up..." : "pi session not initialized",
        });
        bus.emit("agent:processing-done", {});
        return;
      }

      bus.emit("agent:query", { query });

      // Inline producers raw — outputs already self-tag (<shell_events>...).
      const ctxText = String(call("query-context:build") ?? "").trim();
      const final = ctxText ? `${ctxText}\n\n${query}` : query;

      try {
        if (busy) {
          // pi 1.x rejects prompt() mid-run; queue the submit instead.
          await session.followUp(final);
        } else {
          bus.emit("agent:processing-start", {});
          await session.prompt(final);
        }
      } catch (err) {
        bus.emit("agent:error", {
          message: err instanceof Error ? err.message : String(err),
        });
        if (!busy) bus.emit("agent:processing-done", {});
      }
    };

    const onCancel = async () => { await session?.abort(); };
    const onReset = async () => {
      await runtime?.newSession();
      await bindSession();
    };

    const onListModels = async () => {
      if (!session || !modelRuntime) return { models: [], active: null };
      const all = await modelRuntime.getAvailable();
      const cur = session.model;
      return {
        models: all.map((m: any) => ({ id: m.id, provider: m.provider })),
        active: cur ? { id: cur.id, provider: cur.provider } : null,
      };
    };

    const onSwitchModel = async ({ id, provider }: { id: string; provider?: string }) => {
      if (!session || !modelRuntime) return;
      let full: any = provider ? modelRuntime.getModel(provider, id) : null;
      if (!full) {
        const all = (await modelRuntime.getAvailable()) as any[];
        const candidates = all.filter((m: any) => m.id === id && (!provider || m.provider === provider));
        if (candidates.length === 0) {
          bus.emit("ui:error", { message: `Unknown model: ${provider ?? ""}:${id}` });
          return;
        }
        if (candidates.length > 1) {
          const opts = candidates.map((m: any) => `${m.id}@${m.provider}`).join(", ");
          bus.emit("ui:error", { message: `Ambiguous model "${id}". Use one of: ${opts}` });
          return;
        }
        full = candidates[0];
      }
      try {
        await session.setModel(full);
        bus.emit("agent:info", {
          name: "pi",
          version: "1.6",
          model: `${full.provider}/${full.id}`,
        });
        bus.emit("ui:info", { message: `Model: ${full.provider}: ${full.id}` });
        bus.emit("config:changed", {});
      } catch (err) {
        bus.emit("ui:error", {
          message: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    const onGetThinking = () => {
      const level = session?.thinkingLevel ?? "off";
      return { level, levels: [...PI_THINKING_LEVELS], supported: true };
    };

    const onSetThinking = ({ level }: { level: string }) => {
      if (!session) return;
      if (!(PI_THINKING_LEVELS as readonly string[]).includes(level)) {
        bus.emit("ui:error", {
          message: `Unknown thinking level: ${level}. Use: ${PI_THINKING_LEVELS.join(", ")}`,
        });
        return;
      }
      session.setThinkingLevel(level);
      bus.emit("config:changed", {});
    };

    bus.on("agent:submit", onSubmit);
    bus.on("agent:cancel-request", onCancel);
    bus.on("agent:reset-session", onReset);
    bus.on("config:switch-model", onSwitchModel as any);
    bus.on("config:set-thinking", onSetThinking as any);
    bus.onPipe("config:get-models", onListModels as any);
    bus.onPipe("config:get-thinking", onGetThinking as any);
    listeners.push(
      { kind: "on", event: "agent:submit", fn: onSubmit },
      { kind: "on", event: "agent:cancel-request", fn: onCancel },
      { kind: "on", event: "agent:reset-session", fn: onReset },
      { kind: "on", event: "config:switch-model", fn: onSwitchModel },
      { kind: "on", event: "config:set-thinking", fn: onSetThinking },
      { kind: "pipe", event: "config:get-models", fn: onListModels },
      { kind: "pipe", event: "config:get-thinking", fn: onGetThinking },
    );
  };

  const unwireListeners = () => {
    for (const { kind, event, fn } of listeners) {
      if (kind === "pipe") bus.offPipe(event as any, fn as any);
      else bus.off(event as any, fn as any);
    }
    listeners.length = 0;
    unsubscribe?.();
    unsubscribe = undefined;
  };

  bus.emit("agent:register-backend", {
    name: "pi",
    start: async () => {
      await boot();
      wireListeners();
      bus.emit("command:register", {
        name: "/compact",
        description: "Compact pi's session context",
        handler: async () => {
          if (!session) return;
          try {
            await session.compact();
            bus.emit("ui:info", { message: "(compacted)" });
          } catch (err) {
            bus.emit("ui:info", {
              message: `(${err instanceof Error ? err.message : String(err)})`,
            });
          }
        },
      });
      bus.emit("command:register", {
        name: "/context",
        description: "Show pi's context budget usage",
        handler: () => {
          if (!session) return;
          const usage = session.getContextUsage() as { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
          if (!usage || usage.tokens == null) {
            bus.emit("ui:info", { message: "Context: not available yet" });
            return;
          }
          const pct = usage.percent ?? (usage.contextWindow > 0
            ? Math.round((usage.tokens / usage.contextWindow) * 100)
            : 0);
          bus.emit("ui:info", {
            message: `Active context: ~${usage.tokens.toLocaleString()} tokens / ${usage.contextWindow.toLocaleString()} budget (${pct}%)`,
          });
        },
      });
    },
    kill: () => {
      bus.emit("command:unregister", { name: "/compact" });
      bus.emit("command:unregister", { name: "/context" });
      unwireListeners();
      runtime?.dispose();
      session = null;
      runtime = null;
      modelRuntime = null;
      booting = true;
    },
  });
}
