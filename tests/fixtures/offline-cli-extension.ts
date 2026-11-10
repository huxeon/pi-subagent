// Copied into a temporary agent/extensions directory by cli-integration.test.ts.
// No HTTP server or upstream model: every assistant block is generated here.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

const root = process.env.SUBAGENT_FIXTURE_ROOT!;
const child = process.argv.includes("--exclude-tools");
function log(type: string, data: Record<string, unknown> = {}) {
  appendFileSync(join(root, "events.jsonl"), JSON.stringify({ type, pid: process.pid, child, ...data }) + "\n");
}
async function gate(name: string, signal?: AbortSignal) {
  while (!existsSync(join(root, `release-${name}`))) {
    await delay(10, undefined, { signal });
  }
}

export default async function fixture(pi: ExtensionAPI) {
  // Fail closed if any code accidentally attempts a model HTTP request.
  globalThis.fetch = async () => { log("network-attempt"); throw new Error("Offline fixture forbids fetch"); };
  log("factory");
  if (child && existsSync(join(root, "pause-start"))) {
    log("starting");
    await gate("start");
  }
  const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "pending",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      try {
        const users = context.messages.filter((m) => m.role === "user").map((m) =>
          typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
        const last = context.messages.at(-1);
        const text = users.at(-1) ?? "";
        const tools = getCurrentTools(context.messages).map((t) => t.name);
        log("request", { users, tools, model: model.id, provider: model.provider, reasoning: options?.reasoning });
        await options?.onPayload?.({ users }, model);
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        stream.push({ type: "start", partial: message });
        if (last?.role === "user" && text.startsWith("hold:")) {
          await gate(text.slice(5), options?.signal);
        }
        let block: TextContent | ToolCall;
        if (last?.role === "user" && text.startsWith("CALL ")) {
          const call = JSON.parse(text.slice(5)) as { id: string; input: ToolCall["arguments"][string] };
          block = { type: "toolCall", id: call.id, name: "fixture_call", arguments: { input: call.input } };
        } else if (last?.role === "user" && text === "probe-exclusion") {
          block = { type: "toolCall", id: "probe", name: "fixture_probe", arguments: {} };
        } else {
          block = { type: "text", text: child ? `fixed:${JSON.stringify(users)}` : "parent-fixed-response" };
        }
        message.content.push(block);
        if (block.type === "text") {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
        } else {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
        }
        message.stopReason = block.type === "text" ? "stop" : "toolUse";
        stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = String(error);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } finally { stream.end(); }
    })();
    return stream;
  };
  for (const provider of ["fixture", "fixture-other"]) {
    pi.registerProvider(provider, {
      api: "fixture-local", baseUrl: "http://invalid.invalid", apiKey: "not-a-real-key", streamSimple,
      models: ["fixed", "alternate"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 })),
    });
  }
  pi.on("session_start", (_event, ctx) => {
    log("ready", { tools: pi.getAllTools().map((t) => t.name), cwd: ctx.cwd,
      provider: ctx.model?.provider, model: ctx.model?.id, thinking: ctx.thinkingLevel,
      sessionFile: ctx.sessionManager.getSessionFile() });
  });
  pi.on("input", (event) => {
    log("input", { text: event.text, mode: event.streamingBehavior });
    if (event.text === "fixture-handled") return { action: "handled" };
    return undefined;
  });
  pi.on("before_agent_start", (event) => { log("run", { messageType: event.messageType }); });
  pi.on("agent_settled", () => { log("settled"); });
  pi.on("session_shutdown", (event) => { log("shutdown", { reason: event.reason }); });
  pi.on("session_before_compact", async () => {
    log("compacting");
    await gate("compact");
    return { cancel: true };
  });
  pi.registerCommand("fixture-compact", { description: "Hold a real manual compaction",
    handler: async (_args, ctx) => { ctx.compact(); } });
  pi.registerTool({
    name: "fixture_call", label: "Fixture call", description: "Offline test driver",
    parameters: { type: "object", required: ["input"], properties: { input: { type: "object" } } },
    async execute(_id, params, _signal, _update, ctx) {
      const outcome = await ctx.executeTool("subagent", params.input);
      return { ...outcome.result, isError: outcome.isError };
    },
  });
  pi.registerTool({
    name: "fixture_probe", label: "Fixture probe", description: "Actually attempt excluded nested actions",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _update, ctx) {
      pi.setActiveTools([...pi.getActiveTools(), "subagent"]);
      const results = [];
      for (const action of ["spawn", "send"]) {
        results.push(await ctx.executeTool("subagent", { action, name: "nested", message: "must not execute" }));
      }
      log("exclusion", { registered: pi.getAllTools().map((t) => t.name), callable: ctx.tools.map((t) => t.name), results });
      return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
    },
  });
}
