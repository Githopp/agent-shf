import type { ExtensionContext } from "../shell/host-types.js";

/**
 * Built-in equivalent of examples/extensions/command-suggest.ts.
 *
 * Read-only agent modes load this automatically so the model can stage the
 * command that would make a change, instead of trying to run it. Shell owns
 * the injection (see `shell:queue-command`) so it can also clear any pending
 * input-mode return before typing into the prompt.
 */
export function activateCommandSuggest(ctx: ExtensionContext): void {
  if (!ctx.shell || !ctx.agent) return;
  if (ctx.agent.getTools().some((tool) => tool.name === "suggest_command")) return;

  const { bus } = ctx;

  ctx.agent.registerTool({
    name: "suggest_command",
    description:
      "Stage a shell command at the user's prompt. After this response " +
      "completes, the command appears in their shell prompt (not inside " +
      "agent-input mode), ready to edit or run with Enter. " +
      "Use this whenever the user asks for a command, and in read-only mode " +
      "for any change they would need to make (restart a service, edit a " +
      "config, install a package): explain briefly, then stage the command " +
      "instead of trying to run it. Do NOT call it unprompted after a general " +
      "explanation where no command was requested. " +
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

export default activateCommandSuggest;
