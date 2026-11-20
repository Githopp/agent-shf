import type { EventBus } from "../core/event-bus.js";
import type { AgentModeConfig, AgentModeSetting, Settings } from "../core/settings.js";
import type { InputModeConfig } from "./host-types.js";

export interface ResolvedAgentMode extends AgentModeConfig {
  trigger: string;
  label: string;
  promptIcon: string;
  indicator: string;
  readOnly: boolean;
}

function defaultMode(trigger: string): ResolvedAgentMode {
  return {
    trigger,
    label: trigger === ">" ? "agent" : `agent ${trigger}`,
    promptIcon: trigger === ">" ? "❯" : trigger,
    indicator: "●",
    readOnly: false,
  };
}

function resolveOne(trigger: string, raw: AgentModeSetting): ResolvedAgentMode | null {
  if (raw === false || raw === null) return null;
  const cfg: AgentModeConfig = raw === true ? {} : raw;
  const base = defaultMode(trigger);
  return {
    ...base,
    ...cfg,
    trigger,
    label: cfg.label ?? base.label,
    promptIcon: cfg.promptIcon ?? base.promptIcon,
    indicator: cfg.indicator ?? (cfg.readOnly ? "○" : base.indicator),
    readOnly: cfg.readOnly === true,
  };
}

/**
 * Resolve `settings.agentModes` into the triggers the shell will register.
 *
 * An absent/empty map means the historical single `>` mode. When a map is
 * present, `>` stays available unless explicitly disabled with `false`, so
 * users can add `'`/`"` without re-declaring the default.
 */
export function resolveAgentModes(
  settings: Pick<Settings, "agentModes"> = {},
): ResolvedAgentMode[] {
  const raw = settings.agentModes;
  if (!raw || Object.keys(raw).length === 0) return [defaultMode(">")];

  const entries = Object.entries(raw);
  if (!Object.prototype.hasOwnProperty.call(raw, ">")) entries.unshift([">", {}]);

  const out: ResolvedAgentMode[] = [];
  for (const [trigger, value] of entries) {
    // InputHandler keys modes on one UTF-16 code unit. Keep validation tight so
    // a typo (or an emoji) can't silently create an unreachable mode.
    if (trigger.length !== 1 || /\s/.test(trigger) || trigger.charCodeAt(0) < 32) {
      console.warn(`[agent-sh] agentModes: ignoring trigger ${JSON.stringify(trigger)} (must be one non-space character)`);
      continue;
    }
    const mode = resolveOne(trigger, value);
    if (mode) out.push(mode);
  }
  return out;
}

function modeId(trigger: string): string {
  // Preserve the historical id so extension advisors targeting "agent" keep working.
  return trigger === ">" ? "agent" : `agent-${trigger.codePointAt(0)!.toString(16)}`;
}

/** Register one input mode per configured trigger. */
export function registerAgentModes(bus: EventBus, modes: ResolvedAgentMode[]): InputModeConfig[] {
  const registered: InputModeConfig[] = [];

  for (const mode of modes) {
    if ((mode.provider && !mode.model) || (!mode.provider && mode.model)) {
      bus.emit("ui:error", {
        message: `agentModes["${mode.trigger}"]: set provider and model together (or neither).`,
      });
    }

    const config: InputModeConfig = {
      id: modeId(mode.trigger),
      trigger: mode.trigger,
      label: mode.label,
      promptIcon: mode.promptIcon,
      indicator: mode.indicator,
      returnToSelf: true,
      onSubmit(query, b) {
        if (mode.provider && mode.model) {
          b.emit("config:switch-model", {
            id: mode.model,
            provider: mode.provider,
            persist: false,
          });
        }
        b.emit("agent:submit", {
          query,
          ...(mode.readOnly ? { readOnly: true } : {}),
        });
      },
    };

    bus.emit("input-mode:register", config);
    registered.push(config);
  }

  return registered;
}
