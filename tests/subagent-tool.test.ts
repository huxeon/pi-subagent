import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initTheme, ToolExecutionComponent, type ExtensionToolContext, type Theme } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { runToolCall, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createSubagentTool, subagentSchema, validateToolInput, type SubagentInput, type ToolDetails } from "../src/subagent-tool.ts";
import { type CardContext, toolRenderers } from "../src/tool-render.ts";
import { ParentManager } from "../src/parent-manager.ts";
import { ChildBridge } from "../src/child-bridge.ts";
import { createSubagentDirectory } from "../src/paths.ts";
import { SocketServer, SocketTransportError } from "../src/socket-transport.ts";

const config = { provider: "p", model: "m", thinking: "high" as const, cwd: "/parent" };
const ctx = { mode: "print", hasUI: false, cwd: config.cwd, ui: new Proxy({}, { get() { throw new Error("No UI allowed"); } }) } as ExtensionToolContext;
function fixture() {
  const calls: unknown[][] = [];
  const service = {
    create: async (...args: unknown[]) => { calls.push(["create", ...args]); return { name: "a", config: { ...config, thinking: "off" as const }, invoked: true as const }; },
    message: async (...args: unknown[]) => { calls.push(["message", ...args]); return { invoked: true as const }; },
    inspect: async (...args: unknown[]) => { calls.push(["inspect", ...args]); return { state: "idle" as const, reply: { text: "原文 **reply**", stopReason: "stop" as const } }; },
    list: async (...args: unknown[]) => { calls.push(["list", ...args]); return [{ name: "a", status: { available: true as const, workState: "working" as const } }]; },
    destroy: async (...args: unknown[]) => { calls.push(["destroy", ...args]); },
  };
  const tool = createSubagentTool(() => service, () => config);
  const run = (args: unknown, signal?: AbortSignal, updates?: ToolDetails[]) => tool.execute("id", args as SubagentInput, signal, updates ? update => updates.push(update.details) : undefined, ctx);
  return { service, calls, tool, run };
}

test("schema uses provider-friendly operation enum; Pi validates/coerces JSON schema", () => {
  const schemaCheck = (args: unknown) => validateToolArguments({ name: "subagent", description: "", parameters: subagentSchema }, { type: "toolCall", id: "i", name: "subagent", arguments: args as never });
  assert.deepEqual(schemaCheck({ operation: "inspect", name: "a", wait: "true", timeout: "0.125" }), { operation: "inspect", name: "a", wait: true, timeout: 0.125 });
  for (const args of [{}, { operation: "bad" }, { operation: "inspect", extra: 1 }, { operation: "inspect", timeout: 0 }, { operation: "create", thinking: "none" }]) assert.throws(() => schemaCheck(args));
});

test("four-operation validation: required fields, names, strings, cross-operation fields, wait and bounded seconds", async () => {
  const f = fixture();
  const invalid = [null, [], {}, { operation: "bad" },
    ...["create", "message", "destroy"].map(operation => ({ operation })),
    { operation: "create", name: "a" }, { operation: "message", name: "a", prompt: " " },
    { operation: "create", name: "\n", prompt: "p" }, { operation: "create", name: "a", prompt: "p", cwd: "" },
    { operation: "create", name: "a", prompt: "p", provider: "p\0" },
    { operation: "message", name: "a", prompt: "p", followUp: "true" },
    { operation: "inspect", wait: true }, { operation: "inspect", name: " " },
    { operation: "inspect", name: "a", wait: "true" },
    ...[0, -1, NaN, Infinity, 2147483.648, 0.0001, 0.0011, "1"].map(timeout => ({ operation: "inspect", name: "a", wait: true, timeout })),
    { operation: "inspect", name: "a", timeout: 1 },
    { operation: "destroy", name: "a", prompt: "p" }, { operation: "message", name: "a", prompt: "p", wait: false },
  ];
  for (const value of invalid) {
    assert.throws(() => validateToolInput(value), JSON.stringify(value));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const r = await f.run(value); assert.equal(r.isError, true); assert.equal(r.details.phase, "error");
    }
  }
  assert.equal(f.calls.length, 0);
  for (const value of [{ operation: "create", name: "中文/..", prompt: " 原文 " }, { operation: "message", name: "a", prompt: "p" }, { operation: "inspect" }, { operation: "inspect", name: "a", wait: true, timeout: 0.001 }, { operation: "destroy", name: "a" }]) assert.deepEqual(validateToolInput(value), value);
});

test("non-TUI dispatch, creation snapshot, original prompt, signal and seconds conversion; nonwaiting never exposes reply", async () => {
  const f = fixture(); const c = new AbortController(); const updates: ToolDetails[] = [];
  const created = await f.run({ operation: "create", name: "a", prompt: " 原文 ", cwd: "../actual" }, c.signal, updates);
  assert.equal(created.isError, false);
  assert.equal(updates[0]?.config?.cwd, "/actual");
  assert.equal(created.details.config?.thinking, "off");
  assert.equal((f.calls[0]?.[1] as { prompt: string }).prompt, " 原文 ");
  assert.deepEqual(f.calls[0]?.[2], config); // Do not resolve a relative cwd twice.
  assert.equal((f.calls[0]?.[3] as { signal: AbortSignal }).signal, c.signal);
  await f.run({ operation: "message", name: "a", prompt: "p" }, c.signal);
  await f.run({ operation: "message", name: "a", prompt: "p", followUp: true }, c.signal);
  assert.deepEqual(f.calls.slice(1).map(call => call[3]), [false, true]);
  const state = await f.run({ operation: "inspect", name: "a" }, c.signal);
  assert.deepEqual(state.details.data, { state: "idle" }); assert.doesNotMatch(JSON.stringify(state.content), /reply|原文/);
  await f.run({ operation: "inspect", name: "a", wait: true }, c.signal);
  await f.run({ operation: "inspect", name: "a", wait: true, timeout: 0.125 }, c.signal);
  assert.deepEqual(f.calls.slice(4).map(call => call[3]), [{ signal: c.signal, timeoutMs: 1800000 }, { signal: c.signal, timeoutMs: 125 }]);
  await f.run({ operation: "inspect" }, c.signal);
  await f.run({ operation: "destroy", name: "a" }, c.signal);
  assert.deepEqual(f.calls.slice(-2), [["list", { signal: c.signal }], ["destroy", "a", { signal: c.signal }]]);
});

test("all operations preserve failures/details with isError; pre-abort prevents dispatch; list cannot swallow cancellation", async () => {
  for (const operation of ["create", "message", "inspect", "destroy"] as const) {
    for (const code of ["ABORTED", "TIMEOUT", "CONNECTION_CLOSED", "EEXIST", "READY_TIMEOUT"]) {
      const f = fixture();
      const fail = async () => { throw new SocketTransportError(code, "failure"); };
      Object.assign(f.service, { [operation]: fail });
      const r = await f.run({ operation, name: "a", ...(["create", "message"].includes(operation) ? { prompt: "p" } : {}) });
      assert.equal(r.isError, true); assert.equal(r.details.error?.code, code);
      assert.equal(r.details.phase, code === "ABORTED" ? "cancelled" : code.includes("TIMEOUT") ? "timeout" : "error");
    }
    const f = fixture(); const c = new AbortController(); c.abort();
    assert.equal((await f.run({ operation, name: "a", prompt: "p" }, c.signal)).isError, true);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const c = new AbortController();
  f.service.list = async () => { c.abort(); return []; };
  assert.equal((await f.run({ operation: "inspect" }, c.signal)).details.phase, "cancelled");
});

test("in-flight create/message/destroy forward the exact cancellation signal without pretending success", async () => {
  for (const operation of ["create", "message", "destroy"] as const) {
    const f = fixture(); const c = new AbortController();
    let received: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = (...args: unknown[]) => new Promise<never>((_resolve, reject) => {
      received = (args.at(-1) as { signal: AbortSignal }).signal;
      received.addEventListener("abort", () => reject(new SocketTransportError("ABORTED", "cancelled")), { once: true });
      started();
    });
    Object.assign(f.service, { [operation]: work });
    const run = f.run({ operation, name: "a", ...(operation !== "destroy" ? { prompt: "p" } : {}) }, c.signal);
    await ready; assert.equal(received, c.signal); c.abort();
    const outcome = await run;
    assert.equal(outcome.isError, true); assert.equal(outcome.details.phase, "cancelled");
  }
});

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text } as Theme;
function render(args: SubagentInput, details?: ToolDetails, expanded = false, width = 100, fallback?: string, isError = false) {
  const context: CardContext = { args, state: {}, cwd: "/inherited", expanded, isError, durationMs: undefined, isPartial: details?.phase === "running", executionStarted: true, argsComplete: true, toolCallId: "id", showImages: false, outputPad: 0, lastComponent: undefined, invalidate() {}, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" };
  const call = toolRenderers.renderCall(args, theme, context);
  const result = details || fallback !== undefined ? toolRenderers.renderResult({ details, content: [{ type: "text", text: fallback ?? "" }] }, { expanded, isPartial: context.isPartial }, theme, context) : undefined;
  const output = [...call.render(width), ...(result?.render(width) ?? [])];
  for (const row of output) assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} > ${width}: ${row}`);
  return output.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
}
const done = (data?: ToolDetails["data"], c?: ToolDetails["config"]): ToolDetails => ({ version: 1, phase: "done", data, config: c });

test("card snapshots: create retains task and actual cwd, only bottom status changes; expanded effective config", () => {
  const args: SubagentInput = { operation: "create", name: "reviewer", prompt: "Review 当前 changes.", cwd: "../actual" };
  const pending = render(args, { version: 1, phase: "running", config: { ...config, cwd: "/actual" } });
  assert.equal(pending, "subagent create · reviewer\n  Review 当前 changes.\n  cwd: /actual\n\nCreating...");
  const final = render(args, done(undefined, { ...config, cwd: "/actual" }));
  assert.equal(final, pending.replace("Creating...", "✓ Created · p/m:high"));
  assert.match(render(args, done(undefined, config), true), /provider: p\n  model: m\n  thinking: high/);
  assert.match(render({ operation: "create", name: "a", prompt: "p" }), /cwd: \/inherited\n\nCreating\.\.\./);
});

test("message/destroy snapshots and pending states; no prompt/steer mode labels", () => {
  for (const followUp of [undefined, false, true]) {
    const args: SubagentInput = { operation: "message", name: "a", prompt: "原文", followUp };
    assert.equal(render(args, done({ invoked: true })), `subagent message · a${followUp ? " · follow-up" : ""}\n  原文\n\n✓ Delivered`);
    assert.match(render(args), /\n\nDelivering\.\.\./);
  }
  assert.equal(render({ operation: "destroy", name: "a" }), "subagent destroy · a\n\nDestroying...");
  assert.equal(render({ operation: "destroy", name: "a" }, done({ destroyed: true })), "subagent destroy · a\n\n✓ Destroyed · session data deleted");
});

test("inspect list/status/wait snapshots; working/idle unmarked; Markdown reply separated; null/error/aborted never masked", () => {
  const args: SubagentInput = { operation: "inspect", name: "a" };
  assert.equal(render({ operation: "inspect" }, done([{ name: "reviewer", status: { available: true, workState: "working" } }, { name: "implementer", status: { available: true, workState: "idle" } }])), "subagent inspect\n\nreviewer     working\nimplementer  idle");
  assert.equal(render(args, done({ state: "working" })), "subagent inspect · a\n\nworking");
  assert.equal(render(args, done({ state: "idle", reply: { text: "secret", stopReason: "stop" } })), "subagent inspect · a\n\nidle");
  assert.equal(render({ ...args, wait: true }), "subagent inspect · a\n\nWaiting for completion...");
  const success = render({ ...args, wait: true }, done({ state: "idle", reply: { text: "**中文** reply", stopReason: "stop" } }));
  assert.match(success, /idle\n\n中文 reply/); assert.doesNotMatch(success, /✓|\*\*/);
  assert.match(render({ ...args, wait: true }, done({ state: "idle", reply: null })), /idle\n\nNo assistant reply\./);
  for (const stopReason of ["error", "aborted"] as const) {
    const output = render({ ...args, wait: true }, done({ state: "idle", reply: { text: "原文", stopReason, errorMessage: "reason" } }));
    assert.match(output, /idle\n\n/); assert.match(output, /reason/); assert.match(output, /原文/); assert.doesNotMatch(output, /✓ idle/);
    assert.equal(output.includes("✗"), stopReason === "error");
  }
});

test("error/timeout/cancel snapshots, disconnected fact, Pi-owned fallback failures; every operation", () => {
  for (const operation of ["create", "message", "inspect", "destroy"] as const) {
    const args = { operation, name: "a", prompt: "p", wait: operation === "inspect" };
    const r = (phase: ToolDetails["phase"], code: string) => render(args, { version: 1, phase, error: { code, message: "Broken." } });
    assert.match(r("error", "ERROR"), /\n\n✗ Broken\./);
    assert.doesNotMatch(r("cancelled", "ABORTED"), /✗|✓/);
    assert.match(r("timeout", "READY_TIMEOUT"), /✗ Broken\./);
    assert.match(r("error", "CONNECTION_CLOSED"), /✗ Connection lost\. Subagent status is unknown\./);
    assert.match(render(args, undefined, false, 100, "Invalid parameters", true), /✗ Invalid parameters/);
  }
  const args: SubagentInput = { operation: "inspect", name: "a", wait: true };
  assert.equal(render(args, { version: 1, phase: "timeout", error: { code: "TIMEOUT", message: "timeout" } }), "subagent inspect · a\n\n✗ Wait timed out after 1800s. Subagent continues running.");
  assert.equal(render(args, { version: 1, phase: "cancelled", error: { code: "ABORTED", message: "aborted" } }), "subagent inspect · a\n\nWait cancelled. Subagent continues running.");
});

test("compact/expanded Chinese, emoji, long unbroken text, Markdown code/table, narrow terminals; replay needs no live child", async () => {
  const f = fixture();
  const full = "**原文**\n\n" + Array.from({ length: 2100 }, (_, i) => `行${i} 中文😀 ${"long".repeat(20)}`).join("\n") + "\n\n```ts\nconst a = 1;\n```\n\n| x | y |\n|---|---|\n| 中 | 文 |";
  f.service.inspect = async () => ({ state: "idle", reply: { text: full, stopReason: "stop" } });
  const r = await f.run({ operation: "inspect", name: "a", wait: true });
  assert.equal(r.isError, false); assert.equal(r.content[0]?.type, "text");
  if (r.content[0]?.type !== "text") throw new Error("Expected text");
  assert.match(r.content[0].text, /Output truncated/);
  assert.match(r.content[0].text, /stopReason/);
  assert.match(r.content[0].text, /原文/);
  assert.doesNotMatch(r.content[0].text, /\ufffd/);
  assert.ok(r.content[0].text.split("\n").length <= 2000);
  assert.ok(Buffer.byteLength(r.content[0].text) <= 50 * 1024);
  const saved = JSON.parse(JSON.stringify(r.details)) as ToolDetails;
  assert.equal((saved.data as { reply: { text: string } }).reply.text, full);
  for (const width of [1, 2, 7, 20, 80]) {
    const args: SubagentInput = { operation: "inspect", name: "a", wait: true };
    assert.ok(render(args, saved, true, width).length > render(args, saved, false, width).length);
    const prompt = { operation: "create" as const, name: "中文😀", prompt: full };
    assert.ok(render(prompt, done(undefined, config), true, width).length > render(prompt, done(undefined, config), false, width).length);
  }
});

test("tool cancellation and timeout through real manager/socket only remove this inspect; child state/queues untouched", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-"));
  const xdg = join(root, "x"); await mkdir(xdg, { mode: 0o700 });
  const paths = await createSubagentDirectory(root, "parent", "a");
  const transport = { address: { xdgRuntimeDir: xdg } };
  let sends = 0; let stops = 0;
  const bridge = new ChildBridge({ isIdle: () => false, getBranch: () => [], sendUserMessage: () => { sends++; }, identity: () => ({ ...config, runDir: paths.runDir, sessionFile: paths.sessionFile, pid: 42 }) });
  const server = await SocketServer.listen(paths.runDir, bridge.handle, transport);
  const manager = new ParentManager({ agentDir: root, parentSessionId: "parent", transport, driver: { start: async () => { throw new Error("no spawn"); }, isRunning: async () => true, stop: async () => { stops++; } } });
  t.after(async () => { await manager.shutdown("reload"); bridge.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const tool = createSubagentTool(() => manager, () => config);
  const c = new AbortController();
  const cancelled = tool.execute("cancel", { operation: "inspect", name: "a", wait: true }, c.signal, undefined, ctx);
  for (let i = 0; bridge.waitingCount !== 1 && i < 100; i++) await delay(2);
  assert.equal(bridge.waitingCount, 1); c.abort();
  assert.equal((await cancelled).details.phase, "cancelled");
  const timed = await tool.execute("timeout", { operation: "inspect", name: "a", wait: true, timeout: 0.02 }, undefined, undefined, ctx);
  assert.equal(timed.isError, true); assert.equal(timed.details.phase, "timeout");
  for (let i = 0; Number(bridge.waitingCount) !== 0 && i < 100; i++) await delay(2);
  assert.equal(bridge.waitingCount, 0); assert.equal(sends, 0); assert.equal(stops, 0);
  assert.deepEqual(await manager.inspect("a"), { state: "working" });
  assert.deepEqual(await readdir(paths.runDir), []);
});


test("Pi tool runner honors returned isError and preserves details (no model request)", async () => {
  const f = fixture();
  f.service.message = async () => { throw new SocketTransportError("CONNECTION_CLOSED", "lost"); };
  const adapted: AgentTool = { name: f.tool.name, label: f.tool.label, description: f.tool.description, parameters: f.tool.parameters as never,
    execute: (id, args, signal, onUpdate) => f.tool.execute(id, args as SubagentInput, signal, onUpdate, ctx) };
  const toolCall = { type: "toolCall" as const, id: "id", name: "subagent", arguments: { operation: "message", name: "a", prompt: "p" } };
  const outcome = await runToolCall(toolCall, { tools: [adapted], assistantMessage: { role: "assistant", content: [toolCall] } as unknown as AssistantMessage,
    context: { messages: [], tools: [adapted] } });
  assert.equal(outcome.isError, true);
  assert.equal((outcome.result.details as ToolDetails).phase, "error");
  assert.equal((outcome.result.details as ToolDetails).error?.code, "CONNECTION_CLOSED");
});

test("real Pi ToolExecutionComponent composes partial/final slots, reload, expansion and Pi-owned errors", () => {
  const f = fixture();
  const args: SubagentInput = { operation: "create", name: "a", prompt: "原文 " + "long ".repeat(100), cwd: "sub" };
  const ui = { requestRender() {} } as TUI;
  const row = new ToolExecutionComponent("subagent", "id", args, { outputPad: 0 }, f.tool, ui, "/parent");
  const text = () => row.render(50).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
  assert.match(text(), /Creating/);
  row.updateResult({ content: [], details: { version: 1, phase: "running", config: { ...config, cwd: "/parent/sub" } }, isError: false }, true);
  assert.equal(text().match(/subagent create/g)?.length, 1);
  assert.match(text(), /cwd: \/parent\/sub/);
  const saved = JSON.parse(JSON.stringify({ content: [], details: done(undefined, { ...config, cwd: "/parent/sub" }), isError: false }));
  row.updateResult(saved);
  const compact = text();
  assert.equal(compact.match(/subagent create/g)?.length, 1);
  assert.match(compact, /✓ Created/); assert.doesNotMatch(compact, /Creating/);
  const reload = new ToolExecutionComponent("subagent", "id", args, { outputPad: 0 }, f.tool, ui, "/different");
  reload.updateResult(saved);
  assert.deepEqual(reload.render(50), row.render(50));
  row.setExpanded(true); assert.ok(text().length > compact.length);
  row.updateResult({ content: [{ type: "text", text: "Validation failed" }], details: {}, isError: true });
  assert.match(text(), /✗ Validation failed/); assert.doesNotMatch(text(), /✓ Created/);
  row.updateResult({ content: [{ type: "text", text: "Operation aborted" }], details: {}, isError: true });
  assert.match(text(), /Operation cancelled/); assert.doesNotMatch(text(), /✗/);
});
