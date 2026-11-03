import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateName } from "./names.ts";
import { parentConfig } from "./parent-lifecycle.ts";
import { resolveCreateConfig, type ParentManager } from "./parent-manager.ts";
import { thinkingLevels, type EffectiveConfig } from "./session-record.ts";
import { SocketTransportError } from "./socket-transport.ts";
import type { SubagentOperation } from "./types.ts";
import { toolRenderers, type CardState } from "./tool-render.ts";

export const MAX_TIMEOUT_SECONDS = 2_147_483.647;
// A provider-friendly object schema; operation-specific constraints are also
// checked in execute (tool_call hooks can mutate arguments after validation).
export const subagentSchema = Type.Object({
  operation: Type.Unsafe<SubagentOperation["operation"]>(StringEnum(["create", "message", "inspect", "destroy"] as const)),
  name: Type.Optional(Type.String({ minLength: 1, description: "Required except for inspect list; unique within this parent session." })),
  prompt: Type.Optional(Type.String({ minLength: 1, description: "Required for create/message; preserved verbatim." })),
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinking: Type.Optional(Type.Unsafe<EffectiveConfig["thinking"]>(StringEnum(thinkingLevels))),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "create only; relative to current parent cwd; defaults to inherited cwd." })),
  followUp: Type.Optional(Type.Boolean({ default: false, description: "message only; true uses follow-up when busy, otherwise steer." })),
  wait: Type.Optional(Type.Boolean({ default: false, description: "inspect only; true requires name." })),
  timeout: Type.Optional(Type.Number({ minimum: 0.001, multipleOf: 0.001, maximum: MAX_TIMEOUT_SECONDS, default: 1800,
    description: "inspect wait=true only; seconds (millisecond precision), default 1800." })),
}, { additionalProperties: false });
export type SubagentInput = Static<typeof subagentSchema>;

export function validateToolInput(value: unknown): SubagentOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments must be an object.");
  const p = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    create: ["name", "prompt", "provider", "model", "thinking", "cwd"],
    message: ["name", "prompt", "followUp"], inspect: ["name", "wait", "timeout"], destroy: ["name"],
  };
  if (typeof p.operation !== "string" || !Object.hasOwn(fields, p.operation)) throw new Error("operation must be create, message, inspect, or destroy.");
  for (const key of Object.keys(p)) if (key !== "operation" && !fields[p.operation]!.includes(key)) throw new Error(`${key} is not valid for ${p.operation}.`);
  if (p.name !== undefined || p.operation !== "inspect") {
    if (typeof p.name !== "string") throw new Error("name is required.");
    validateName(p.name);
  }
  for (const key of ["prompt", "provider", "model", "cwd"]) {
    if (p[key] !== undefined && (typeof p[key] !== "string" || !(p[key] as string).trim() || (p[key] as string).includes("\0"))) throw new Error(`${key} must be a nonblank string without NUL.`);
  }
  if (["create", "message"].includes(p.operation) && p.prompt === undefined) throw new Error("prompt is required.");
  if (p.thinking !== undefined && !thinkingLevels.includes(p.thinking as EffectiveConfig["thinking"])) throw new Error("Invalid thinking level.");
  for (const key of ["wait", "followUp"]) if (p[key] !== undefined && typeof p[key] !== "boolean") throw new Error(`${key} must be boolean.`);
  if (p.wait === true && p.name === undefined) throw new Error("wait=true requires name.");
  if (p.timeout !== undefined) {
    if (p.wait !== true) throw new Error("timeout is only valid with wait=true.");
    if (typeof p.timeout !== "number" || !Number.isFinite(p.timeout) || p.timeout < 0.001 || p.timeout > MAX_TIMEOUT_SECONDS || Math.abs(p.timeout * 1000 - Math.round(p.timeout * 1000)) > 1e-6) throw new Error(`timeout must be 0.001–${MAX_TIMEOUT_SECONDS} seconds with millisecond precision.`);
  }
  return { ...p } as SubagentOperation;
}

type Service = Pick<ParentManager, "create" | "message" | "inspect" | "list" | "destroy">;
export interface ToolDetails {
  version: 1;
  phase: "running" | "done" | "error" | "cancelled" | "timeout";
  config?: EffectiveConfig;
  data?: Awaited<ReturnType<Service["create"]>> | Awaited<ReturnType<Service["inspect"]>> | Awaited<ReturnType<Service["list"]>> | { invoked: true } | { destroyed: true };
  error?: { code: string; message: string };
}

function result(details: ToolDetails, text: string, isError = false) {
  let visible = text.split("\n").slice(0, 1995).join("\n");
  const bytes = Buffer.from(visible, "utf8");
  if (bytes.length > 50 * 1024 - 256) {
    let end = 50 * 1024 - 256;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    visible = bytes.subarray(0, end).toString("utf8");
  }
  return { content: [{ type: "text" as const, text: visible + (visible !== text ? "\n\n[Output truncated to 50 KiB / 2000 lines. Full response is preserved in this tool result's details in the parent session.]" : "") }], details, isError };
}
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new SocketTransportError("ABORTED", "Operation cancelled"); };

export function createSubagentTool(current: () => Service, config: (ctx: ExtensionContext) => EffectiveConfig): ToolDefinition<typeof subagentSchema, ToolDetails, CardState> {
  return {
    name: "subagent", label: "subagent", parameters: subagentSchema,
    description: "Manage persistent collaborative Pi subagents via operation=create/message/inspect/destroy. create requires name and prompt; optional provider/model/thinking/cwd inherit current parent settings. message requires name and prompt; followUp defaults false. Delivered only means the input API call was initiated, not reliable delivery or task completion. inspect without name lists states; with name returns status only unless wait=true. wait=true requires name; timeout is seconds, default 1800, max 2147483.647 (millisecond precision). Cancellation of inspect never stops the child or changes its queues. destroy requires name and deletes session data. Other operations' fields are rejected. Model-visible output is limited to 50 KiB / 2000 lines; full returned response remains in parent tool details. idle does not imply task success.",
    promptSnippet: "Create, message, inspect/wait for, or destroy collaborative subagents",
    async execute(_id, input, signal, onUpdate, ctx) {
      let effective: EffectiveConfig | undefined;
      let inherited: EffectiveConfig | undefined;
      try {
        const p = validateToolInput(input);
        aborted(signal);
        const manager = current();
        let data: ToolDetails["data"];
        if (p.operation === "create") {
          inherited = config(ctx);
          effective = resolveCreateConfig(p, inherited);
        }
        onUpdate?.(result({ version: 1, phase: "running", ...(effective ? { config: effective } : {}) }, "Operation in progress."));
        switch (p.operation) {
          case "create": {
            const created = await manager.create(p, inherited!, { signal });
            effective = created.config; data = created; break;
          }
          case "message": data = await manager.message(p.name, p.prompt, p.followUp ?? false, { signal }); break;
          case "inspect": {
            if (p.name === undefined) {
              data = await manager.list({ signal });
              aborted(signal); // list isolates per-child errors, including aborts.
            } else {
              const inspected = await manager.inspect(p.name, p.wait ?? false, { signal, ...(p.wait ? { timeoutMs: Math.round((p.timeout ?? 1800) * 1000) } : {}) });
              // Nonwaiting results must never expose a reply, even from a faulty adapter.
              data = p.wait ? inspected : { state: inspected.state };
            }
            break;
          }
          case "destroy": await manager.destroy(p.name, { signal }); data = { destroyed: true }; break;
        }
        const details: ToolDetails = { version: 1, phase: "done", data, ...(effective ? { config: effective } : {}) };
        const reply = p.operation === "inspect" && p.wait && data && !Array.isArray(data) && "reply" in data ? data.reply : undefined;
        // Put outcome metadata before the raw reply, so long replies cannot hide
        // stopReason/errorMessage and byte truncation still exposes a useful prefix.
        const visibleData = reply && data && !Array.isArray(data) && "state" in data ? { state: data.state, reply: { stopReason: reply.stopReason, ...(reply.errorMessage !== undefined ? { errorMessage: reply.errorMessage } : {}) } } : data;
        const text = JSON.stringify({ operation: p.operation, name: p.name, ...("invoked" in data! ? { acknowledgement: "Input API invocation initiated only; not guaranteed accepted, queued, persisted, or completed." } : {}), result: visibleData }, null, 2);
        return result(details, text + (reply ? `\n\n${reply.text}` : ""));
      } catch (error) {
        const errorCode = (error as { code?: unknown })?.code;
        const code = typeof errorCode === "string" ? errorCode : error instanceof Error && error.name === "AbortError" ? "ABORTED" : "ERROR";
        const message = code === "EEXIST" ? `A subagent named ${JSON.stringify(input?.name)} already exists.` : error instanceof Error ? error.message : String(error);
        const phase = code === "ABORTED" ? "cancelled" : code.includes("TIMEOUT") ? "timeout" : "error";
        return result({ version: 1, phase, error: { code, message }, ...(effective ? { config: effective } : {}) }, JSON.stringify({ operation: input?.operation, error: { code, message }, cancelled: phase === "cancelled" }), true);
      }
    },
    ...toolRenderers,
  };
}

export function registerSubagentTool(pi: ExtensionAPI, lifecycle: { current(): ParentManager }): void {
  pi.registerTool(createSubagentTool(() => lifecycle.current(), ctx => parentConfig(pi, ctx)));
}
