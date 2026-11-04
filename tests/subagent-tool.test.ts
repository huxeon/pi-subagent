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

const operations = ["spawn", "send", "list", "status", "wait", "stop"] as const;
const config = { provider: "p", model: "m", thinking: "high" as const, cwd: "/parent" };
const ctx = { mode: "print", hasUI: false, cwd: config.cwd, ui: new Proxy({}, { get() { throw new Error("No UI allowed"); } }) } as ExtensionToolContext;
function fixture() {
  const calls: unknown[][] = [];
  const service = {
    spawn: async (...args: unknown[]) => { calls.push(["spawn", ...args]); return { name: "a", config: { ...config, thinking: "off" as const }, invoked: true as const }; },
    send: async (...args: unknown[]) => { calls.push(["send", ...args]); return { invoked: true as const }; },
    // Include a stray reply to verify that status never exposes it.
    status: async (...args: unknown[]) => { calls.push(["status", ...args]); return { state: "idle" as const, reply: { text: "secret", stopReason: "stop" as const } }; },
    wait: async (...args: unknown[]) => { calls.push(["wait", ...args]); return { state: "idle" as const, reply: { text: "原文 **reply**", stopReason: "stop" as const } }; },
    list: async (...args: unknown[]) => { calls.push(["list", ...args]); return [{ name: "a", status: { available: true as const, workState: "working" as const } }]; },
    stop: async (...args: unknown[]) => { calls.push(["stop", ...args]); },
  };
  const tool = createSubagentTool(() => service, () => config);
  const run = (args: unknown, signal?: AbortSignal, updates?: ToolDetails[]) => tool.execute("id", args as SubagentInput, signal, updates ? update => updates.push(update.details) : undefined, ctx);
  return { service, calls, tool, run };
}

test("schema uses exactly six provider-friendly operations; Pi validates/coerces JSON schema and rejects legacy names/wait", () => {
  const schemaCheck = (args: unknown) => validateToolArguments({ name: "subagent", description: "", parameters: subagentSchema }, { type: "toolCall", id: "i", name: "subagent", arguments: args as never });
  const operationSchema = subagentSchema.properties.operation as unknown as { enum: readonly string[] };
  assert.deepEqual(operationSchema.enum, [...operations]);
  assert.equal(Object.hasOwn(subagentSchema.properties, "wait"), false);
  for (const operation of operations) {
    const args = operation === "list" ? { operation } : { operation, name: "a", ...(["spawn", "send"].includes(operation) ? { prompt: "p" } : {}) };
    assert.deepEqual(schemaCheck(args), args);
    for (const wait of [true, false, "true", "false"]) assert.throws(() => schemaCheck({ ...args, wait }));
  }
  assert.deepEqual(schemaCheck({ operation: "wait", name: "a", timeout: "0.125" }), { operation: "wait", name: "a", timeout: 0.125 });
  assert.deepEqual(schemaCheck({ operation: "send", name: "a", prompt: "p", followUp: "true" }), { operation: "send", name: "a", prompt: "p", followUp: true });
  for (const args of [{}, { operation: "bad" }, { operation: "status", extra: 1 }, { operation: "wait", name: "a", timeout: 0 }, { operation: "spawn", thinking: "none" },
    ...["create", "message", "inspect", "destroy"].map(operation => ({ operation, name: "a", prompt: "p" }))]) assert.throws(() => schemaCheck(args));
});

test("six-operation validation: required fields, names, strings, legacy aliases and bounded wait seconds", async () => {
  const f = fixture();
  const invalid = [null, [], {}, { operation: "bad" },
    ...["create", "message", "inspect", "destroy"].flatMap(operation => [{ operation }, { operation, name: "a", prompt: "p" }]),
    ...operations.filter(operation => operation !== "list").flatMap(operation => [{ operation }, { operation, name: " " }, { operation, name: "a\0b" }]),
    ...["spawn", "send"].flatMap(operation => [
      { operation, name: "a" }, { operation, name: "a", prompt: " " }, { operation, name: "a", prompt: "p\0" }, { operation, name: "a", prompt: 1 },
    ]),
    ...["provider", "model", "cwd"].flatMap(field => ["", " ", "p\0", 1].map(value => ({ operation: "spawn", name: "a", prompt: "p", [field]: value }))),
    { operation: "spawn", name: "a", prompt: "p", thinking: "none" },
    { operation: "send", name: "a", prompt: "p", followUp: "true" },
    ...[0, -1, NaN, Infinity, 2147483.648, 0.0001, 0.0011, "1"].map(timeout => ({ operation: "wait", name: "a", timeout })),
  ];
  for (const value of invalid) {
    assert.throws(() => validateToolInput(value), JSON.stringify(value));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const r = await f.run(value); assert.equal(r.isError, true); assert.equal(r.details.phase, "error");
    }
  }
  assert.equal(f.calls.length, 0);
  for (const value of [
    { operation: "spawn", name: "中文/..", prompt: " 原文 ", provider: "p", model: "m", thinking: "high", cwd: "../actual" },
    { operation: "send", name: "a", prompt: "p" }, { operation: "send", name: "a", prompt: "p", followUp: false },
    { operation: "send", name: "a", prompt: "p", followUp: true }, { operation: "list" }, { operation: "status", name: "a" },
    { operation: "wait", name: "a" }, { operation: "wait", name: "a", timeout: 0.001 },
    { operation: "wait", name: "a", timeout: 2147483.647 }, { operation: "stop", name: "a" },
  ]) assert.deepEqual(validateToolInput(value), value);
});

test("every operation rejects foreign fields, including list name, non-wait timeout and even wait=false", async () => {
  const f = fixture();
  const fields: Record<string, unknown> = { name: "a", prompt: "p", provider: "p", model: "m", thinking: "high", cwd: "/work", followUp: false, timeout: 1, wait: false, extra: 1 };
  const allowed: Record<typeof operations[number], string[]> = {
    spawn: ["name", "prompt", "provider", "model", "thinking", "cwd"], send: ["name", "prompt", "followUp"],
    list: [], status: ["name"], wait: ["name", "timeout"], stop: ["name"],
  };
  for (const operation of operations) {
    const base = operation === "list" ? { operation } : { operation, name: "a", ...(["spawn", "send"].includes(operation) ? { prompt: "p" } : {}) };
    for (const [field, value] of Object.entries(fields)) {
      if (allowed[operation].includes(field)) continue;
      for (const foreignValue of field === "wait" ? [true, false, "true", "false"] : [value]) {
        const args = { ...base, [field]: foreignValue };
        assert.throws(() => validateToolInput(args), `${operation}: ${field}=${JSON.stringify(foreignValue)}`);
        const result = await f.run(args);
        assert.equal(result.isError, true); assert.equal(result.details.phase, "error");
      }
    }
  }
  assert.equal(f.calls.length, 0);
});

test("non-TUI six-operation dispatch, spawn snapshot, original prompt, signal and seconds conversion; status never exposes reply", async () => {
  const f = fixture(); const c = new AbortController(); const updates: ToolDetails[] = [];
  const spawned = await f.run({ operation: "spawn", name: "a", prompt: " 原文 ", cwd: "../actual" }, c.signal, updates);
  assert.equal(spawned.isError, false);
  assert.equal(updates[0]?.config?.cwd, "/actual");
  assert.equal(spawned.details.config?.thinking, "off");
  assert.deepEqual(f.calls[0]?.[1], { operation: "spawn", name: "a", prompt: " 原文 ", cwd: "../actual" });
  assert.deepEqual(f.calls[0]?.[2], config); // Do not resolve a relative cwd twice.
  assert.equal((f.calls[0]?.[3] as { signal: AbortSignal }).signal, c.signal);
  await f.run({ operation: "send", name: "a", prompt: " 原文 " }, c.signal);
  await f.run({ operation: "send", name: "a", prompt: "p", followUp: true }, c.signal);
  assert.deepEqual(f.calls.slice(1), [["send", "a", " 原文 ", false, { signal: c.signal }], ["send", "a", "p", true, { signal: c.signal }]]);
  const state = await f.run({ operation: "status", name: "a" }, c.signal);
  assert.equal(state.isError, false);
  assert.deepEqual(state.details.data, { state: "idle" }); assert.doesNotMatch(JSON.stringify(state.content), /reply|secret/);
  assert.deepEqual(f.calls[3], ["status", "a", { signal: c.signal }]);
  const waited = await f.run({ operation: "wait", name: "a" }, c.signal);
  assert.equal(waited.isError, false);
  assert.deepEqual(waited.details.data, { state: "idle", reply: { text: "原文 **reply**", stopReason: "stop" } });
  assert.match(JSON.stringify(waited.content), /原文/);
  await f.run({ operation: "wait", name: "a", timeout: 0.125 }, c.signal);
  assert.deepEqual(f.calls.slice(4), [["wait", "a", { signal: c.signal, timeoutMs: 1800000 }], ["wait", "a", { signal: c.signal, timeoutMs: 125 }]]);
  const listed = await f.run({ operation: "list" }, c.signal);
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.details.data, [{ name: "a", status: { available: true, workState: "working" } }]);
  const stopped = await f.run({ operation: "stop", name: "a" }, c.signal);
  assert.equal(stopped.isError, false); assert.deepEqual(stopped.details.data, { stopped: true });
  assert.deepEqual(f.calls.slice(-2), [["list", { signal: c.signal }], ["stop", "a", { signal: c.signal }]]);
  assert.deepEqual(f.calls.map(call => call[0]), ["spawn", "send", "send", "status", "wait", "wait", "list", "stop"]);
});

test("all operations preserve failures/details with isError; pre-abort prevents dispatch; list cannot swallow cancellation", async () => {
  for (const operation of operations) {
    const args = operation === "list" ? { operation } : { operation, name: "a", ...(["spawn", "send"].includes(operation) ? { prompt: "p" } : {}) };
    for (const code of ["ABORTED", "TIMEOUT", "CONNECTION_CLOSED", "EEXIST", "READY_TIMEOUT"]) {
      const f = fixture();
      const fail = async () => { throw new SocketTransportError(code, "failure"); };
      Object.assign(f.service, { [operation]: fail });
      const r = await f.run(args);
      assert.equal(r.isError, true); assert.equal(r.details.error?.code, code);
      assert.equal(r.details.phase, code === "ABORTED" ? "cancelled" : code.includes("TIMEOUT") ? "timeout" : "error");
    }
    const f = fixture(); const c = new AbortController(); c.abort();
    const cancelled = await f.run(args, c.signal);
    assert.equal(cancelled.isError, true); assert.equal(cancelled.details.phase, "cancelled");
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); const c = new AbortController();
  f.service.list = async () => { c.abort(); return []; };
  assert.equal((await f.run({ operation: "list" }, c.signal)).details.phase, "cancelled");
});

test("all six in-flight operations forward the exact cancellation signal without pretending success", async () => {
  for (const operation of operations) {
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
    const args = operation === "list" ? { operation } : { operation, name: "a", ...(["spawn", "send"].includes(operation) ? { prompt: "p" } : {}) };
    const run = f.run(args, c.signal);
    await ready; assert.equal(received, c.signal); c.abort();
    const outcome = await run;
    assert.equal(outcome.isError, true); assert.equal(outcome.details.phase, "cancelled");
  }
});

initTheme("dark", false);
const boldInputs: string[] = [];
const colorInputs: Array<[string, string]> = [];
const theme = {
  fg: (color: string, text: string) => { colorInputs.push([color, text]); return text; },
  bold: (text: string) => { boldInputs.push(text); return `\x1b[1m${text}\x1b[22m`; },
} as Theme;
function render(args: SubagentInput, details?: ToolDetails, expanded = false, width = 100, fallback?: string, isError = false) {
  const context: CardContext = { args, state: {}, cwd: "/inherited", expanded, isError, durationMs: undefined, isPartial: details?.phase === "running", executionStarted: true, argsComplete: true, toolCallId: "id", showImages: false, outputPad: 0, lastComponent: undefined, invalidate() {}, keyText: () => "ctrl+o", keyHint: () => "ctrl+o to expand" };
  const call = toolRenderers.renderCall(args, theme, context);
  const result = details || fallback !== undefined ? toolRenderers.renderResult({ details, content: [{ type: "text", text: fallback ?? "" }] }, { expanded, isPartial: context.isPartial }, theme, context) : undefined;
  const output = [...call.render(width), ...(result?.render(width) ?? [])];
  for (const row of output) assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} > ${width}: ${row}`);
  return output.map(row => row.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
}
const done = (data?: ToolDetails["data"], c?: ToolDetails["config"]): ToolDetails => ({ version: 1, phase: "done", data, config: c });

test("all tool headings bold only the tool name, preserving plain operations and names across pending/final cards", () => {
  for (const operation of operations) {
    const args = operation === "list" ? { operation } : { operation, name: "reviewer", ...(["spawn", "send"].includes(operation) ? { prompt: "Review" } : {}), ...(operation === "send" ? { followUp: true } : {}) };
    for (const details of [undefined, done(undefined, config)]) {
      boldInputs.length = 0;
      colorInputs.length = 0;
      const output = render(args, details);
      assert.deepEqual(boldInputs, ["subagent"]);
      assert.ok(!colorInputs.some(([, text]) => text.includes("reviewer")));
      assert.equal(output.split("\n")[0], `subagent ${operation}${operation === "list" ? "" : " reviewer"}${operation === "send" ? " (follow-up)" : operation === "wait" ? " (timeout 1800s)" : ""}`);
    }
  }
});

test("compact labels: only wait has effective timeout, only enabled send follow-up is labeled", () => {
  const title = (args: SubagentInput) => render(args, undefined, false, 240).split("\n")[0];
  assert.equal(title({ operation: "list" }), "subagent list");
  assert.equal(title({ operation: "status", name: "a" }), "subagent status a");
  assert.equal(title({ operation: "wait", name: "a" }), "subagent wait a (timeout 1800s)");
  assert.equal(title({ operation: "wait", name: "a", timeout: 60 }), "subagent wait a (timeout 60s)");
  assert.equal(title({ operation: "send", name: "a", prompt: "p", followUp: false }), "subagent send a");
  assert.equal(title({ operation: "send", name: "a", prompt: "p", followUp: true }), "subagent send a (follow-up)");
  assert.equal(title({ operation: "stop", name: "a" }), "subagent stop a");
  assert.equal(title({ operation: "spawn", name: "a", prompt: "p", provider: "p", model: "m", thinking: "high", cwd: "/work" }), "subagent spawn a");
});

test("parenthesized options use muted color separately from the tool title, like built-in bash timeout", () => {
  for (const [args, suffix] of [
    [{ operation: "send", name: "a", prompt: "p", followUp: true }, " (follow-up)"],
    [{ operation: "wait", name: "a" }, " (timeout 1800s)"],
    [{ operation: "wait", name: "a", timeout: 60 }, " (timeout 60s)"],
  ] as const) {
    for (const details of [undefined, done()]) {
      colorInputs.length = 0;
      render(args, details);
      assert.ok(colorInputs.some(([color, text]) => color === "muted" && text === suffix));
      assert.ok(colorInputs.some(([color, text]) => color === "toolTitle" && text.includes("subagent") && text.includes(` ${args.operation}`) && !text.includes(suffix)));
    }
  }
});

test("card snapshots: spawn retains task and actual cwd, only bottom status changes; expanded config is not duplicated", () => {
  const args: SubagentInput = { operation: "spawn", name: "reviewer", prompt: "Review 当前 changes.", cwd: "../actual" };
  const pending = render(args, { version: 1, phase: "running", config: { ...config, cwd: "/actual" } });
  assert.equal(pending, "subagent spawn reviewer\n  Review 当前 changes.\n  cwd: /actual\n\nSpawning...");
  const final = render(args, done(undefined, { ...config, cwd: "/actual" }));
  assert.equal(final, pending.replace("Spawning...", "✓ Spawned · p/m:high"));
  const expanded = render(args, done(undefined, config), true);
  assert.doesNotMatch(expanded, /provider:|model:|thinking:/);
  assert.match(expanded, /cwd: \/parent/);
  assert.match(expanded, /✓ Spawned · p\/m:high/);
  assert.match(render({ operation: "spawn", name: "a", prompt: "p" }), /cwd: \/inherited\n\nSpawning\.\.\./);
});

test("send/stop snapshots and pending states; no prompt/steer mode labels", () => {
  for (const followUp of [undefined, false, true]) {
    const args: SubagentInput = { operation: "send", name: "a", prompt: "原文", followUp };
    assert.equal(render(args, done({ invoked: true })), `subagent send a${followUp ? " (follow-up)" : ""}\n  原文\n\n✓ Delivered`);
    assert.match(render(args), /\n\nDelivering\.\.\./);
  }
  assert.equal(render({ operation: "stop", name: "a" }), "subagent stop a\n\nStopping...");
  assert.equal(render({ operation: "stop", name: "a" }, done({ stopped: true })), "subagent stop a\n\n✓ Stopped · session data deleted");
});

test("separate list/status/wait snapshots; working/idle unmarked; Markdown reply separated; null/error/aborted never masked", () => {
  const statusArgs: SubagentInput = { operation: "status", name: "a" };
  const waitArgs: SubagentInput = { operation: "wait", name: "a" };
  assert.equal(render({ operation: "list" }, done([{ name: "reviewer", status: { available: true, workState: "working" } }, { name: "implementer", status: { available: true, workState: "idle" } }])), "subagent list\n\nreviewer     working\nimplementer  idle");
  assert.equal(render(statusArgs, done({ state: "working" })), "subagent status a\n\nworking");
  assert.equal(render(statusArgs, done({ state: "idle" })), "subagent status a\n\nidle");
  assert.equal(render(statusArgs, done({ state: "idle", reply: { text: "secret", stopReason: "stop" } })), "subagent status a\n\nidle");
  assert.equal(render(waitArgs), "subagent wait a (timeout 1800s)\n\nWaiting for completion...");
  const success = render(waitArgs, done({ state: "idle", reply: { text: "**中文** reply", stopReason: "stop" } }));
  assert.match(success, /\n\n中文 reply/); assert.doesNotMatch(success, /\nidle\n/); assert.doesNotMatch(success, /✓|\*\*/);
  assert.match(render(waitArgs, done({ state: "idle", reply: null })), /\n\nNo assistant reply\./);
  for (const stopReason of ["error", "aborted"] as const) {
    const output = render(waitArgs, done({ state: "idle", reply: { text: "原文", stopReason, errorMessage: "reason" } }));
    assert.doesNotMatch(output, /\nidle\n/); assert.match(output, /reason/); assert.match(output, /原文/); assert.doesNotMatch(output, /✓ idle/);
    assert.equal(output.includes("✗"), stopReason === "error");
  }
});

test("error/timeout/cancel snapshots, disconnected fact, Pi-owned fallback failures; every operation", () => {
  for (const operation of operations) {
    const args = operation === "list" ? { operation } : { operation, name: "a", ...(["spawn", "send"].includes(operation) ? { prompt: "p" } : {}) };
    const r = (phase: ToolDetails["phase"], code: string) => render(args, { version: 1, phase, error: { code, message: "Broken." } });
    assert.match(r("error", "ERROR"), /\n\n✗ Broken\./);
    assert.doesNotMatch(r("cancelled", "ABORTED"), /✗|✓/);
    assert.match(r("timeout", "READY_TIMEOUT"), /✗ Broken\./);
    assert.match(r("error", "CONNECTION_CLOSED"), /✗ Connection lost\. Subagent status is unknown\./);
    assert.match(render(args, undefined, false, 100, "Invalid parameters", true), /✗ Invalid parameters/);
  }
  for (const timeout of [undefined, 0.125, 60]) {
    const args: SubagentInput = { operation: "wait", name: "a", ...(timeout !== undefined ? { timeout } : {}) };
    const seconds = timeout ?? 1800;
    assert.equal(render(args, { version: 1, phase: "timeout", error: { code: "TIMEOUT", message: "timeout" } }), `subagent wait a (timeout ${seconds}s)\n\n✗ Wait timed out after ${seconds}s. Subagent continues running.`);
    assert.equal(render(args, { version: 1, phase: "cancelled", error: { code: "ABORTED", message: "aborted" } }), `subagent wait a (timeout ${seconds}s)\n\nWait cancelled. Subagent continues running.`);
  }
});

test("historical operation results replay stored content without enabling legacy execution aliases", () => {
  for (const operation of ["create", "message", "inspect", "destroy"]) {
    const args = { operation, name: "a", ...(operation === "inspect" ? { wait: true } : {}) } as unknown as SubagentInput;
    const content = "历史回复 中文😀\n" + "original result\n".repeat(12) + "\x1b[31muntrusted\x1b[0m";
    const compact = render(args, done({ state: "idle", reply: { text: "历史回复", stopReason: "stop" } }), false, 80, content);
    const expanded = render(args, done(), true, 80, content);
    assert.match(compact, /历史回复/);
    assert.match(expanded, /untrusted/);
    assert.doesNotMatch(expanded, /\x1b/);
    assert.ok(expanded.split("\n").length > compact.split("\n").length);
    assert.throws(() => validateToolInput(args));
    assert.match(render(args, done()), /Result unavailable\./);
  }
});

test("compact/expanded Chinese, emoji, long unbroken text, Markdown code/table, narrow terminals; replay needs no live child", async () => {
  const f = fixture();
  const full = "**原文**\n\n" + Array.from({ length: 2100 }, (_, i) => `行${i} 中文😀 ${"long".repeat(20)}`).join("\n") + "\n\n```ts\nconst a = 1;\n```\n\n| x | y |\n|---|---|\n| 中 | 文 |";
  f.service.wait = async () => ({ state: "idle", reply: { text: full, stopReason: "stop" } });
  const r = await f.run({ operation: "wait", name: "a" });
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
    const args: SubagentInput = { operation: "wait", name: "a" };
    assert.ok(render(args, saved, true, width).length > render(args, saved, false, width).length);
    const prompt = { operation: "spawn" as const, name: "中文😀", prompt: full };
    assert.ok(render(prompt, done(undefined, config), true, width).length > render(prompt, done(undefined, config), false, width).length);
  }
});

test("tool wait cancellation and timeout through real manager/socket only remove the socket inspect; child state/queues untouched", async t => {
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
  const cancelled = tool.execute("cancel", { operation: "wait", name: "a" }, c.signal, undefined, ctx);
  for (let i = 0; bridge.waitingCount !== 1 && i < 100; i++) await delay(2);
  assert.equal(bridge.waitingCount, 1); c.abort();
  assert.equal((await cancelled).details.phase, "cancelled");
  const timed = await tool.execute("timeout", { operation: "wait", name: "a", timeout: 0.02 }, undefined, undefined, ctx);
  assert.equal(timed.isError, true); assert.equal(timed.details.phase, "timeout");
  for (let i = 0; Number(bridge.waitingCount) !== 0 && i < 100; i++) await delay(2);
  assert.equal(bridge.waitingCount, 0); assert.equal(sends, 0); assert.equal(stops, 0);
  assert.deepEqual(await manager.status("a", {}), { state: "working" });
  assert.deepEqual(await readdir(paths.runDir), []);
});


test("Pi tool runner honors returned isError and preserves details (no model request)", async () => {
  const f = fixture();
  f.service.send = async () => { throw new SocketTransportError("CONNECTION_CLOSED", "lost"); };
  const adapted: AgentTool = { name: f.tool.name, label: f.tool.label, description: f.tool.description, parameters: f.tool.parameters as never,
    execute: (id, args, signal, onUpdate) => f.tool.execute(id, args as SubagentInput, signal, onUpdate, ctx) };
  const toolCall = { type: "toolCall" as const, id: "id", name: "subagent", arguments: { operation: "send", name: "a", prompt: "p" } };
  const outcome = await runToolCall(toolCall, { tools: [adapted], assistantMessage: { role: "assistant", content: [toolCall] } as unknown as AssistantMessage,
    context: { messages: [], tools: [adapted] } });
  assert.equal(outcome.isError, true);
  assert.equal((outcome.result.details as ToolDetails).phase, "error");
  assert.equal((outcome.result.details as ToolDetails).error?.code, "CONNECTION_CLOSED");
});

test("real Pi ToolExecutionComponent composes partial/final slots, reload, expansion and Pi-owned errors", () => {
  const f = fixture();
  const args: SubagentInput = { operation: "spawn", name: "a", prompt: "原文 " + "long ".repeat(100), cwd: "sub" };
  const ui = { requestRender() {} } as TUI;
  const row = new ToolExecutionComponent("subagent", "id", args, { outputPad: 0 }, f.tool, ui, "/parent");
  const text = () => row.render(50).map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd()).join("\n");
  assert.match(text(), /Spawning/);
  row.updateResult({ content: [], details: { version: 1, phase: "running", config: { ...config, cwd: "/parent/sub" } }, isError: false }, true);
  assert.equal(text().match(/subagent spawn/g)?.length, 1);
  assert.match(text(), /cwd: \/parent\/sub/);
  const saved = JSON.parse(JSON.stringify({ content: [], details: done(undefined, { ...config, cwd: "/parent/sub" }), isError: false }));
  row.updateResult(saved);
  const compact = text();
  assert.equal(compact.match(/subagent spawn/g)?.length, 1);
  assert.match(compact, /✓ Spawned/); assert.doesNotMatch(compact, /Spawning/);
  const reload = new ToolExecutionComponent("subagent", "id", args, { outputPad: 0 }, f.tool, ui, "/different");
  reload.updateResult(saved);
  assert.deepEqual(reload.render(50), row.render(50));
  row.setExpanded(true); assert.ok(text().length > compact.length);
  row.updateResult({ content: [{ type: "text", text: "Validation failed" }], details: {}, isError: true });
  assert.match(text(), /✗ Validation failed/); assert.doesNotMatch(text(), /✓ Spawned/);
  row.updateResult({ content: [{ type: "text", text: "Operation aborted" }], details: {}, isError: true });
  assert.match(text(), /Operation cancelled/); assert.doesNotMatch(text(), /✗/);
});
