import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { ChildBridge, registerChildBridge } from "../src/child-bridge.ts";
import type { ChildPiAdapter } from "../src/child-bridge.ts";
import { SocketClient, SocketServer } from "../src/socket-transport.ts";
import type { JsonValue } from "../src/socket-transport.ts";

function fakePi() {
  let idle = true;
  let branch: SessionEntry[] = [];
  let reads = 0;
  const sends: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const adapter: ChildPiAdapter = {
    isIdle: () => idle,
    getBranch: () => { reads++; return branch; },
    sendUserMessage: (...args) => { sends.push(args); },
  };
  return { adapter, sends, get reads() { return reads; }, setIdle(value: boolean) { idle = value; }, setBranch(value: SessionEntry[]) { branch = value; } };
}
function assistant(text: string, stopReason = "stop", errorMessage?: string): SessionEntry {
  // Only test fixture construction is partial; production reads the real Pi SessionEntry union.
  return { type: "message", id: "a", parentId: null, timestamp: "now", message: {
    role: "assistant", content: [{ type: "thinking", thinking: "SECRET", thinkingSignature: "SECRET" }, { type: "text", text }],
    stopReason, errorMessage,
  } } as SessionEntry;
}
const request = (bridge: ChildBridge, method: string, params: JsonValue, controller = new AbortController()) =>
  bridge.handle(method, params, { id: 1, signal: controller.signal });
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as NodeJS.ErrnoException).code, expected);
  return true;
};
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) assert.fail("Condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xdgRuntimeDir = join(root, "xdg");
  const runDir = join(root, "run");
  await mkdir(xdgRuntimeDir, { mode: 0o700 });
  await mkdir(runDir);
  const options = { address: { xdgRuntimeDir }, connectTimeoutMs: 1000 };
  const connect = async () => {
    const client = await SocketClient.connect(runDir, options);
    t.after(() => client.close());
    return client;
  };
  return { root, runDir, xdgRuntimeDir, options, connect };
}

test("message calls public void API once, idle direct and busy steer/followUp; no speculative state", () => {
  const pi = fakePi();
  const bridge = new ChildBridge(pi.adapter);
  assert.deepEqual(request(bridge, "message", { prompt: "原样 prompt", followUp: true }), { invoked: true });
  assert.deepEqual(pi.sends, [["原样 prompt"]]);
  // API invocation need not start work (e.g. input hook handles it).
  assert.deepEqual(request(bridge, "inspect", {}), { state: "idle" });
  pi.setIdle(false);
  bridge.agentStart();
  request(bridge, "message", { prompt: "steer" });
  request(bridge, "message", { prompt: "follow", followUp: true });
  assert.deepEqual(pi.sends.slice(1), [["steer", { deliverAs: "steer" }], ["follow", { deliverAs: "followUp" }]]);
  assert.equal(pi.reads, 0);
  bridge.close();
});

test("non-wait inspect never reads reply; wait uses latest current branch, including empty errors/aborts", () => {
  const pi = fakePi();
  const bridge = new ChildBridge(pi.adapter);
  pi.setBranch([assistant("old"), assistant("", "aborted", "Interrupted")]);
  assert.deepEqual(request(bridge, "inspect", { wait: false }), { state: "idle" });
  assert.equal(pi.reads, 0);
  assert.deepEqual(request(bridge, "inspect", { wait: true }), { state: "idle", reply: { text: "", stopReason: "aborted", errorMessage: "Interrupted" } });
  pi.setBranch([assistant("partial", "error", "provider failed")]);
  assert.deepEqual(request(bridge, "inspect", { wait: true }), { state: "idle", reply: { text: "partial", stopReason: "error", errorMessage: "provider failed" } });
  pi.setBranch([assistant("current")]);
  assert.deepEqual(request(bridge, "inspect", { wait: true }), { state: "idle", reply: { text: "current", stopReason: "stop" } });
  pi.setBranch([]); // Navigate to a branch with no assistant: do not cache the former result.
  assert.deepEqual(request(bridge, "inspect", { wait: true }), { state: "idle", reply: null });
  bridge.close();
});

test("working waits only complete at settled AND actual idle; independent waits release listeners", async () => {
  const pi = fakePi();
  pi.setIdle(false);
  const bridge = new ChildBridge(pi.adapter);
  const a = new AbortController();
  const b = new AbortController();
  const first = request(bridge, "inspect", { wait: true }, a);
  const second = request(bridge, "inspect", { wait: true }, b);
  assert.equal(bridge.waitingCount, 2);
  bridge.agentSettled(); // still busy (queued continuation/retry)
  assert.equal(bridge.waitingCount, 2);
  assert.equal(pi.reads, 0);
  pi.setIdle(true);
  assert.deepEqual(request(bridge, "inspect", {}), { state: "idle" });
  assert.equal(bridge.waitingCount, 2); // A status query is not a settlement event.
  pi.setBranch([assistant("finished")]);
  bridge.agentSettled();
  const expected = { state: "idle", reply: { text: "finished", stopReason: "stop" } };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.equal(bridge.waitingCount, 0);
  assert.equal(getEventListeners(a.signal, "abort").length, 0);
  assert.equal(getEventListeners(b.signal, "abort").length, 0);
  bridge.close();
});

test("cancellation is synchronous and request-local; close is idempotent, no late result reads", async () => {
  const pi = fakePi();
  pi.setIdle(false);
  const bridge = new ChildBridge(pi.adapter);
  const controller = new AbortController();
  const cancelled = assert.rejects(Promise.resolve(request(bridge, "inspect", { wait: true }, controller)), code("ABORTED"));
  const closed = assert.rejects(Promise.resolve(request(bridge, "inspect", { wait: true })), code("BRIDGE_CLOSED"));
  controller.abort();
  assert.equal(bridge.waitingCount, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  bridge.close();
  bridge.close();
  await Promise.all([cancelled, closed]);
  pi.setIdle(true);
  bridge.agentSettled();
  assert.equal(pi.reads, 0);
  assert.equal(pi.sends.length, 0);
  assert.equal(bridge.waitingCount, 0);
  assert.throws(() => request(bridge, "inspect", {}), code("BRIDGE_CLOSED"));
});

test("invalid methods/parameters and pre-cancellation have no Pi side effects", () => {
  const pi = fakePi();
  const bridge = new ChildBridge(pi.adapter);
  assert.throws(() => request(bridge, "abort", {}), code("METHOD_NOT_FOUND"));
  for (const params of [null, [], "bad"]) assert.throws(() => request(bridge, "inspect", params), code("INVALID_PARAMS"));
  for (const params of [{}, { prompt: 1 }, { prompt: " " }, { prompt: "p", followUp: "true" }] as JsonValue[]) {
    assert.throws(() => request(bridge, "message", params), code("INVALID_PARAMS"));
  }
  assert.throws(() => request(bridge, "inspect", { wait: 1 }), code("INVALID_PARAMS"));
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => request(bridge, "message", { prompt: "p" }, controller), code("ABORTED"));
  assert.equal(pi.sends.length, 0);
  assert.equal(pi.reads, 0);
});

test("real transport cancellation/timeout/disconnect isolate waits; remaining peer settles", async t => {
  const f = await fixture(t);
  const pi = fakePi();
  pi.setIdle(false);
  const bridge = new ChildBridge(pi.adapter);
  const server = await SocketServer.listen(f.runDir, bridge.handle, f.options);
  t.after(async () => { await server.close(); bridge.close(); });
  const a = await f.connect();
  const b = await f.connect();
  const controller = new AbortController();
  const cancelled = assert.rejects(a.request("inspect", { wait: true }, { signal: controller.signal }), code("ABORTED"));
  const timedOut = assert.rejects(a.request("inspect", { wait: true }, { timeoutMs: 100 }), code("TIMEOUT"));
  const disconnected = assert.rejects(a.request("inspect", { wait: true }), code("CONNECTION_CLOSED"));
  const survivor = b.request("inspect", { wait: true });
  await until(() => bridge.waitingCount === 4);
  assert.deepEqual(await b.request("inspect", {}), { state: "working" });
  controller.abort();
  await cancelled;
  await until(() => bridge.waitingCount === 3);
  await timedOut;
  await until(() => bridge.waitingCount === 2);
  await a.close();
  await disconnected;
  await until(() => bridge.waitingCount === 1);
  pi.setBranch([assistant("done")]);
  pi.setIdle(true);
  bridge.agentSettled();
  assert.deepEqual(await survivor, { state: "idle", reply: { text: "done", stopReason: "stop" } });
  assert.equal(pi.reads, 1); // no reply reads for the three removed requests
  assert.equal(pi.sends.length, 0);
  assert.equal(bridge.waitingCount, 0);
  assert.deepEqual(await readdir(f.runDir), []); // no persistent bridge state
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function eventHost(send?: ExtensionAPI["sendUserMessage"]) {
  const handlers = new Map<string, Handler>();
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = new Proxy({}, { get(_target, key) {
    if (key === "registerCommand") return (name: string) => { commands.push(name); };
    if (key === "registerTool") return (tool: { name: string }) => { tools.push(tool.name); };
    if (key === "sendUserMessage" && send) return send;
    if (key === "getThinkingLevel") return () => "high";
    if (key === "on") return (name: string, handler: Handler) => { handlers.set(name, handler); return () => handlers.delete(name); };
    throw new Error(`Unexpected capability: ${String(key)}`); // tool/UI/resource filtering forbidden
  } }) as ExtensionAPI;
  return { pi, handlers, tools, commands, emit: async (name: string, ctx: ExtensionContext) => { await handlers.get(name)?.({ type: name }, ctx); } };
}

test("entry registers one parent tool, no child tools or UI/resources", () => {
  const previous = process.env.PI_SUBAGENT_RUN_DIR;
  try {
    delete process.env.PI_SUBAGENT_RUN_DIR;
    const parent = eventHost();
    extension(parent.pi);
    assert.deepEqual(parent.tools, ["subagent"]);
    assert.deepEqual(parent.commands, ["subagent"]);
    assert.deepEqual([...parent.handlers.keys()], ["session_start", "session_shutdown"]);
    process.env.PI_SUBAGENT_RUN_DIR = "/unused/child";
    const child = eventHost();
    extension(child.pi);
    assert.deepEqual(child.tools, []);
    assert.deepEqual(child.commands, []);
    assert.deepEqual([...child.handlers.keys()], ["session_start", "agent_start", "agent_settled", "session_shutdown"]);
    process.env.PI_SUBAGENT_RUN_DIR = "";
    assert.throws(() => extension(child.pi));
    process.env.PI_SUBAGENT_RUN_DIR = "relative";
    assert.throws(() => extension(child.pi));
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_RUN_DIR;
    else process.env.PI_SUBAGENT_RUN_DIR = previous;
  }
});

test("session lifecycle starts only on start, ignores agent_end, shutdown cleans socket/waits; fresh runtime reopens", async t => {
  const f = await fixture(t);
  const pi = fakePi();
  pi.setIdle(false);
  const ctx = { isIdle: pi.adapter.isIdle, sessionManager: { getBranch: pi.adapter.getBranch } } as ExtensionContext;
  const host = eventHost(pi.adapter.sendUserMessage);
  registerChildBridge(host.pi, f.runDir, f.options);
  t.after(() => host.emit("session_shutdown", ctx));
  assert.deepEqual(await readdir(f.xdgRuntimeDir), []);
  await host.emit("session_start", ctx);
  await host.emit("session_start", ctx); // no duplicate listener
  const client = await f.connect();
  assert.deepEqual(await client.request("message", { prompt: "busy" }), { invoked: true });
  assert.deepEqual(pi.sends, [["busy", { deliverAs: "steer" }]]);
  let done = false;
  const wait = client.request("inspect", { wait: true }).then(result => { done = true; return result; });
  await client.request("inspect", {}); // ordered after waiter registration
  await host.emit("agent_end", ctx);
  assert.equal(done, false);
  await host.emit("agent_settled", ctx); // busy confirmation blocks completion
  assert.equal(done, false);
  pi.setIdle(true);
  await host.emit("agent_settled", ctx);
  assert.deepEqual(await wait, { state: "idle", reply: null });
  pi.setIdle(false);
  const interrupted = assert.rejects(client.request("inspect", { wait: true }), error => {
    assert.ok(["CONNECTION_CLOSED", "BRIDGE_CLOSED"].includes((error as NodeJS.ErrnoException).code!));
    return true;
  });
  await client.request("inspect", {});
  await Promise.all([host.emit("session_shutdown", ctx), host.emit("session_shutdown", ctx)]);
  await interrupted;
  await assert.rejects(lstat(client.socketPath), code("ENOENT"));
  const replacement = eventHost();
  registerChildBridge(replacement.pi, f.runDir, f.options);
  await replacement.emit("session_start", ctx);
  const next = await f.connect();
  assert.deepEqual(await next.request("inspect", {}), { state: "working" });
  await replacement.emit("session_shutdown", ctx);
  assert.deepEqual(await readdir(f.runDir), []);
});

test("live identity reports the actual child session/configuration without requiring persistence", async t => {
  const f = await fixture(t);
  const host = eventHost(() => {});
  const ctx = { cwd: "/actual/cwd", model: { provider: "p", id: "m" }, isIdle: () => true,
    sessionManager: { getSessionFile: () => "/actual/session.jsonl", getBranch: () => [] } } as unknown as ExtensionContext;
  registerChildBridge(host.pi, f.runDir, f.options);
  t.after(() => host.emit("session_shutdown", ctx));
  await host.emit("session_start", ctx);
  const client = await f.connect();
  assert.deepEqual(await client.request("identity", {}), { runDir: f.runDir, sessionFile: "/actual/session.jsonl",
    pid: process.pid, cwd: "/actual/cwd", provider: "p", model: "m", thinking: "high" });
  await client.close();
});

test("shutdown during pending startup awaits and closes its owned listener", async t => {
  const f = await fixture(t);
  const pi = fakePi();
  const ctx = { isIdle: pi.adapter.isIdle, sessionManager: { getBranch: pi.adapter.getBranch } } as ExtensionContext;
  const host = eventHost();
  registerChildBridge(host.pi, f.runDir, f.options);
  const starting = host.emit("session_start", ctx);
  const stopping = host.emit("session_shutdown", ctx);
  await Promise.all([starting, stopping]);
  const runtime = join(f.xdgRuntimeDir, "pi-subagent");
  assert.deepEqual(await readdir(runtime), []);
  await host.emit("session_shutdown", ctx);
});

test("failed duplicate startup reports error; its shutdown does not close or unlink the active owner", async t => {
  const f = await fixture(t);
  const pi = fakePi();
  const ctx = { isIdle: pi.adapter.isIdle, sessionManager: { getBranch: pi.adapter.getBranch } } as ExtensionContext;
  const owner = eventHost();
  const duplicate = eventHost();
  registerChildBridge(owner.pi, f.runDir, f.options);
  registerChildBridge(duplicate.pi, f.runDir, f.options);
  t.after(() => owner.emit("session_shutdown", ctx));
  await owner.emit("session_start", ctx);
  await assert.rejects(duplicate.emit("session_start", ctx), code("SOCKET_IN_USE"));
  await duplicate.emit("session_shutdown", ctx);
  const client = await f.connect();
  assert.deepEqual(await client.request("inspect", {}), { state: "idle" });
  assert.ok((await lstat(client.socketPath)).isSocket());
});
