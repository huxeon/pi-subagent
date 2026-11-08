import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseSubagentInput, SUBAGENT_TOOL_NAME, THINKING_LEVELS } from "./config.ts";
import type { SubagentManager } from "./manager.ts";

// Keep a provider-friendly object schema with plain string enums. Action-specific
// constraints (notably the provider/model pair) are checked in execute as well.
export const subagentParameters = {
  type: "object",
  required: ["action", "name", "message"],
  properties: {
    action: { type: "string", enum: ["spawn", "send"], description: "Start a named child or send it another message." },
    name: { type: "string", minLength: 1, pattern: "\\S", description: "Exact child name, unique within this parent session. Must not be blank." },
    message: { type: "string", minLength: 1, pattern: "\\S", description: "Task or message text. Must not be blank." },
    provider: { type: "string", minLength: 1, pattern: "\\S", description: "spawn only: provider; must be supplied together with model. Omit both to inherit the parent's current model." },
    model: { type: "string", minLength: 1, pattern: "\\S", description: "spawn only: model ID; must be supplied together with provider." },
    thinking: { type: "string", enum: THINKING_LEVELS, description: "spawn only: independently optional thinking level. Omit to inherit the parent's current thinking level." },
    mode: { type: "string", enum: ["steer", "followUp"], default: "steer", description: "send only: queue mode when the child is busy; defaults to steer. An idle child starts a new run." },
  },
} as const;

export function registerSubagentTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  manager: Pick<SubagentManager, "spawn" | "send">,
): void {
  pi.registerTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description: "Manage asynchronous named subagents. Use spawn to start a child and send for later messages. " +
      "Returns only RPC acceptance (started/queued/handled), NOT task completion. " +
      "When a child settles, its last assistant text is reported asynchronously via subagent.report. " +
      "Children stay alive after reporting and can receive more messages. handled may produce no report. " +
      "For spawn, provider/model must be supplied together or both omitted; thinking is independently optional. " +
      "Omitted configuration is inherited from the parent at call time. send.mode defaults to steer.",
    promptSnippet: "Start named asynchronous subagents or send them more work",
    parameters: subagentParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Revalidate here too: tool_call hooks can mutate input after schema validation.
      // Throwing preserves parameter/RPC errors as Pi's standard failed tool results.
      const input = parseSubagentInput(params);
      const model = input.action === "spawn" ? ctx.model : undefined;
      const result = input.action === "spawn"
        ? await manager.spawn(input, {
          cwd: ctx.cwd,
          model: model ? { provider: model.provider, id: model.id } : undefined,
          thinkingLevel: ctx.thinkingLevel,
        })
        : await manager.send(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
