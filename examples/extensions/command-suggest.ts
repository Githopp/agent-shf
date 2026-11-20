/**
 * command-suggest extension
 *
 * Registers the suggest_command tool. When the agent calls it, the response
 * finishes and the user drops to the shell prompt with the command pre-typed
 * — no copy-paste, no mode toggle, just review and press Enter.
 *
 * Read-only agent modes load the same tool automatically (src/extensions/
 * command-suggest.ts), so this extension is only needed when you want the tool
 * in every mode.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/command-suggest.ts
 *
 *   # Or install permanently:
 *   cp examples/extensions/command-suggest.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;

  // No shell to deliver to (e.g. ashi) — the suggestion would go nowhere.
  if (!ctx.shell) return;
  if (ctx.agent?.getTools().some((tool) => tool.name === "suggest_command")) return;

  ctx.agent?.registerTool({
    name: "suggest_command",
    description:
      "Stage a shell command at the user's prompt. After this response " +
      "completes, the command appears in their shell prompt (not inside " +
      "agent-input mode), ready to edit or run with Enter. " +
      "Only call this when the user is asking for a command to run, or otherwise " +
      "signals they want one staged — e.g. \"give me the command to …\", " +
      "\"what do I run to …\". Do NOT call it unprompted after a general question, " +
      "an explanation, or any turn where no command was requested. " +
      "Prefer it over telling the user to copy-paste a command. " +
      "Only the most recent call matters. Call with an empty string to clear.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to place in the user's prompt. " +
            "Multi-line commands are collapsed to a single line.",
        },
      },
      required: ["command"],
    },
    showOutput: true,

    getDisplayInfo: () => ({ icon: "⏎" }),

    formatCall: (args) => {
      const cmd = (args.command as string).trim();
      if (!cmd) return "(clear suggestion)";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    },

    async execute(args) {
      const cmd = (args.command as string).trim();
      if (!cmd) {
        bus.emit("shell:queue-command", { command: "" });
        return { content: "Cleared pending command suggestion.", exitCode: 0, isError: false };
      }
      const command = cmd.replace(/\n/g, " ");
      bus.emit("shell:queue-command", { command });
      return {
        content: `Will place at the shell prompt: ${command}`,
        exitCode: 0,
        isError: false,
      };
    },
  });
}
