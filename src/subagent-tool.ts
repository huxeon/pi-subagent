import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateName } from "./names.ts";
import { parentConfig } from "./parent-lifecycle.ts";
import { resolveSpawnConfig, type ParentManager } from "./parent-manager.ts";
import { thinkingLevels, type EffectiveConfig } from "./session-record.ts";
import { SocketTransportError } from "./socket-transport.ts";
import type { SubagentOperation } from "./types.ts";
import { toolRenderers, type CardState } from "./tool-render.ts";

export const MAX_TIMEOUT_SECONDS = 2_147_483.647;
// A provider-friendly object schema; operation-specific constraints are also
// checked in execute (tool_call hooks can mutate arguments after validation).
export const subagentSchema = Type.Object({
  operation: Type.Unsafe<SubagentOperation["operation"]>(StringEnum(["spawn", "send", "list", "status", "wait", "stop"] as const)),
  name: Type.Optional(Type.String({ minLength: 1, description: "Required except for list; unique within this parent session." })),
  prompt: Type.Optional(Type.String({ minLength: 1, description: "Required for spawn/send; preserved verbatim." })),
  provider: Type.Optional(Type.String({ minLength: 1 })),
  model: Type.Optional(Type.String({ minLength: 1 })),
  thinking: Type.Optional(Type.Unsafe<EffectiveConfig["thinking"]>(StringEnum(thinkingLevels))),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "spawn only; relative to current parent cwd; defaults to inherited cwd." })),
  followUp: Type.Optional(Type.Boolean({ default: false, description: "send only; true uses follow-up when busy, otherwise steer." })),
  timeout: Type.Optional(Type.Number({ minimum: 0.001, multipleOf: 0.001, maximum: MAX_TIMEOUT_SECONDS, default: 1800,
    description: "wait only; seconds (millisecond precision), default 1800." })),
}, { additionalProperties: false });
export type SubagentInput = Static<typeof subagentSchema>;

export function validateToolInput(value: unknown): SubagentOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments must be an object.");
  const p = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    spawn: ["name", "prompt", "provider", "model", "thinking", "cwd"],
    send: ["name", "prompt", "followUp"], list: [], status: ["name"], wait: ["name", "timeout"], stop: ["name"],
  };
  if (typeof p.operation !== "string" || !Object.hasOwn(fields, p.operation)) throw new Error("operation must be spawn, send, list, status, wait, or stop.");
  for (const key of Object.keys(p)) if (key !== "operation" && !fields[p.operation]!.includes(key)) throw new Error(`${key} is not valid for ${p.operation}.`);
  if (p.operation !== "list") {
    if (typeof p.name !== "string") throw new Error("name is required.");
    validateName(p.name);
  }
  for (const key of ["prompt", "provider", "model", "cwd"]) {
    if (p[key] !== undefined && (typeof p[key] !== "string" || !(p[key] as string).trim() || (p[key] as string).includes("\0"))) throw new Error(`${key} must be a nonblank string without NUL.`);
  }
  if (["spawn", "send"].includes(p.operation) && p.prompt === undefined) throw new Error("prompt is required.");
  if (p.thinking !== undefined && !thinkingLevels.includes(p.thinking as EffectiveConfig["thinking"])) throw new Error("Invalid thinking level.");
  if (p.followUp !== undefined && typeof p.followUp !== "boolean") throw new Error("followUp must be boolean.");
  if (p.timeout !== undefined) {
    if (typeof p.timeout !== "number" || !Number.isFinite(p.timeout) || p.timeout < 0.001 || p.timeout > MAX_TIMEOUT_SECONDS || Math.abs(p.timeout * 1000 - Math.round(p.timeout * 1000)) > 1e-6) throw new Error(`timeout must be 0.001–${MAX_TIMEOUT_SECONDS} seconds with millisecond precision.`);
  }
  return { ...p } as SubagentOperation;
}

type Service = Pick<ParentManager, "spawn" | "send" | "list" | "status" | "wait" | "stop">;
export interface ToolDetails {
  version: 1;
  phase: "running" | "done" | "error" | "cancelled" | "timeout";
  config?: EffectiveConfig;
  data?: Awaited<ReturnType<Service["spawn"]>> | Awaited<ReturnType<Service["status"]>> | Awaited<ReturnType<Service["wait"]>> | Awaited<ReturnType<Service["list"]>> | { invoked: true } | { stopped: true };
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
    description: "Manage persistent collaborative Pi subagents via operation=spawn/send/list/status/wait/stop. spawn requires name and prompt; optional provider/model/thinking/cwd inherit current parent settings. send requires name and prompt; followUp defaults false. Delivered only means the input API call was initiated, not reliable delivery or task completion. list takes no other fields and lists states. status requires name and returns status only, without a reply. wait requires name and returns the latest assistant reply once idle (immediately if already idle); optional timeout is seconds, default 1800, max 2147483.647 (millisecond precision). Cancellation or timeout of wait never stops the child or changes its queues. stop requires name, stops the child, and permanently deletes its entire run directory and session history. Other operations' fields are rejected. Model-visible output is limited to 50 KiB / 2000 lines; full returned response remains in parent tool details. idle does not imply task success.",
    promptSnippet: "Spawn, send to, list, check status, wait for, or stop collaborative subagents",
    async execute(_id, input, signal, onUpdate, ctx) {
      let effective: EffectiveConfig | undefined;
      let inherited: EffectiveConfig | undefined;
      try {
        const p = validateToolInput(input);
        aborted(signal);
        const manager = current();
        let data: ToolDetails["data"];
        if (p.operation === "spawn") {
          inherited = config(ctx);
          effective = resolveSpawnConfig(p, inherited);
        }
        onUpdate?.(result({ version: 1, phase: "running", ...(effective ? { config: effective } : {}) }, "Operation in progress."));
        switch (p.operation) {
          case "spawn": {
            const spawned = await manager.spawn(p, inherited!, { signal });
            effective = spawned.config; data = spawned; break;
          }
          case "send": data = await manager.send(p.name, p.prompt, p.followUp ?? false, { signal }); break;
          case "list": {
            data = await manager.list({ signal });
            aborted(signal); // list isolates per-child errors, including aborts.
            break;
          }
          case "status": {
            const observed = await manager.status(p.name, { signal });
            // Status must never expose a reply, even from a faulty adapter.
            data = { state: observed.state };
            break;
          }
          case "wait": data = await manager.wait(p.name, { signal, timeoutMs: Math.round((p.timeout ?? 1800) * 1000) }); break;
          case "stop": await manager.stop(p.name, { signal }); data = { stopped: true }; break;
        }
        const details: ToolDetails = { version: 1, phase: "done", data, ...(effective ? { config: effective } : {}) };
        const reply = p.operation === "wait" && data && !Array.isArray(data) && "reply" in data ? data.reply : undefined;
        // Put outcome metadata before the raw reply, so long replies cannot hide
        // stopReason/errorMessage and byte truncation still exposes a useful prefix.
        const visibleData = reply && data && !Array.isArray(data) && "state" in data ? { state: data.state, reply: { stopReason: reply.stopReason, ...(reply.errorMessage !== undefined ? { errorMessage: reply.errorMessage } : {}) } } : data;
        const text = JSON.stringify({ operation: p.operation, name: "name" in p ? p.name : undefined, ...("invoked" in data! ? { acknowledgement: "Input API invocation initiated only; not guaranteed accepted, queued, persisted, or completed." } : {}), result: visibleData }, null, 2);
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
