import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChildBridge } from "../src/child-bridge.ts";
import { ParentManager, resolveCreateConfig } from "../src/parent-manager.ts";
import { registerParentLifecycle } from "../src/parent-lifecycle.ts";
import { createSubagentDirectory, getSubagentPaths } from "../src/paths.ts";
import type { ProcessDriver } from "../src/process-driver.ts";
import { readSessionRecord, type EffectiveConfig } from "../src/session-record.ts";
import { SocketServer, type JsonValue, type TransportOptions } from "../src/socket-transport.ts";

export function record(config: EffectiveConfig): string {
  const timestamp = new Date().toISOString();
  return [ { type: "session", version: 3, id: "test-child", timestamp, cwd: config.cwd },
    { type: "model_change", id: "m", parentId: null, timestamp, provider: config.provider, modelId: config.model },
    { type: "thinking_level_change", id: "t", parentId: "m", timestamp, thinkingLevel: config.thinking },
    { type: "message", id: "u", parentId: "t", timestamp, message: { role: "user", content: "original", timestamp: Date.now() } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-parent-"));
  const xdg = join(root, "xdg"); await mkdir(xdg, { mode: 0o700 });
  const config: EffectiveConfig = { provider: "p", model: "m", thinking: "high", cwd: root };
  const transport: TransportOptions = { address: { xdgRuntimeDir: xdg }, connectTimeoutMs: 50 };
  const calls: Array<{ op: string; name: string; config?: EffectiveConfig }> = [];
  const servers = new Map<string, SocketServer>();
  const bridges = new Map<string, ChildBridge>();
  const prompts: string[] = [];
  const busy = new Set<string>();
  const flags = { failStart: false, noReady: false, noPersist: false, invalidPersist: false, failStop: false, mismatch: false, clamp: false };
  const driver: ProcessDriver = {
    isRunning: async paths => busy.has(paths.name) || servers.has(paths.name),
    start: async (paths, override) => {
      calls.push({ op: "start", name: paths.name, config: override });
      assert.equal(await readFile(paths.sessionFile, "utf8").then(() => true, () => false), override ? false : true);
      if (flags.failStart) throw new Error("start failed");
      busy.add(paths.name);
      if (flags.noReady) return;
      const saved = override ?? await readSessionRecord(paths.sessionFile);
      const live = flags.mismatch ? { ...saved, model: "fallback" } : flags.clamp ? { ...saved, thinking: "off" as const } : saved;
      const bridge = new ChildBridge({
        isIdle: () => false, getBranch: () => [],
        identity: () => ({ ...live, pid: 42, runDir: paths.runDir, sessionFile: paths.sessionFile }),
        sendUserMessage: prompt => {
          prompts.push(String(prompt));
          if (!flags.noPersist) writeFileSync(paths.sessionFile, flags.invalidPersist ? "" : record(live));
        },
      });
      bridges.set(paths.name, bridge);
      servers.set(paths.name, await SocketServer.listen(paths.runDir, bridge.handle, transport));
    },
    stop: async paths => {
      calls.push({ op: "stop", name: paths.name });
      if (flags.failStop) throw new Error("stop failed");
      bridges.get(paths.name)?.close(); bridges.delete(paths.name);
      await servers.get(paths.name)?.close(); servers.delete(paths.name); busy.delete(paths.name);
    },
  };
  const options = { agentDir: root, parentSessionId: "parent", driver, transport, readyTimeoutMs: 60, persistenceTimeoutMs: 60, pollMs: 3 };
  const manager = new ParentManager(options);
  t.after(async () => { flags.failStop = false; await manager.shutdown("quit").catch(() => {}); for (const s of servers.values()) await s.close(); await rm(root, { recursive: true, force: true }); });
  const paths = (name: string) => getSubagentPaths(root, "parent", name);
  return { root, xdg, config, transport, manager, options, flags, calls, servers, prompts, busy, bridges, paths };
}
const input = (name = "worker") => ({ operation: "create" as const, name, prompt: "original" });

test("configuration inherits each current parent field independently, relative cwd and validation", async t => {
  const f = await fixture(t);
  assert.deepEqual(resolveCreateConfig(input(), f.config), f.config);
  assert.deepEqual(resolveCreateConfig({ ...input(), provider: "q", thinking: "off", cwd: "./dir/.." }, f.config), { ...f.config, provider: "q", thinking: "off" });
  assert.throws(() => resolveCreateConfig({ ...input(), model: "" }, f.config));
  assert.throws(() => resolveCreateConfig({ ...input(), prompt: " " }, f.config));
  await assert.rejects(f.manager.create(input(""), f.config));
});

test("create reserves unique name, no prebuilt JSONL, sends prompt once and waits for valid record, not assistant", async t => {
  const f = await fixture(t);
  const result = await f.manager.create(input(), f.config);
  assert.deepEqual(result, { name: "worker", config: f.config, invoked: true });
  assert.deepEqual(await readSessionRecord(f.paths("worker").sessionFile), f.config);
  const before = await readFile(f.paths("worker").sessionFile, "utf8");
  await assert.rejects(f.manager.create(input(), f.config), { code: "EEXIST" });
  assert.equal(await readFile(f.paths("worker").sessionFile, "utf8"), before);
  assert.deepEqual(f.prompts, ["original"]);
  const simultaneous = await Promise.allSettled([f.manager.create(input("same"), f.config), f.manager.create(input("same"), f.config)]);
  assert.equal(simultaneous.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(item => item.op === "start").length, 2);
});

test("start failure, ready timeout and ready+invoked without valid persistence clean only newly owned resources", async t => {
  for (const flag of ["failStart", "noReady", "noPersist", "invalidPersist"] as const) {
    const f = await fixture(t);
    await createSubagentDirectory(f.root, "parent", "existing");
    await writeFile(f.paths("existing").sessionFile, "do not touch");
    f.flags[flag] = true;
    await assert.rejects(f.manager.create(input(), f.config), flag === "failStart" ? /start failed/ : { code: flag === "noReady" ? "READY_TIMEOUT" : "PERSISTENCE_TIMEOUT" });
    assert.equal(await readdir(f.paths("worker").parentDir).then(names => names.includes("n-776f726b6572")), false);
    assert.equal(await readFile(f.paths("existing").sessionFile, "utf8"), "do not touch");
    assert.equal(f.servers.size, 0);
  }
});

test("message/instant inspect/wait inspect propagate cancellation and timeout without stopping child", async t => {
  const f = await fixture(t); await f.manager.create(input(), f.config);
  assert.deepEqual(await f.manager.inspect("worker"), { state: "working" });
  assert.deepEqual(await f.manager.message("worker", "steer", true), { invoked: true });
  await assert.rejects(f.manager.inspect("worker", true, { timeoutMs: 10 }), { code: "TIMEOUT" });
  const abort = new AbortController();
  const waiting = f.manager.inspect("worker", true, { timeoutMs: 500, signal: abort.signal });
  await delay(5); abort.abort();
  await assert.rejects(waiting, { code: "ABORTED" });
  await delay(5);
  assert.equal(f.bridges.get("worker")!.waitingCount, 0);
  assert.equal(f.calls.filter(item => item.op === "stop").length, 0);
  assert.deepEqual((await f.manager.list())[0]?.status, { available: true, workState: "working" });
});

test("create cancellation and stop failure retain records rather than deleting a live process", async t => {
  const f = await fixture(t); f.flags.noPersist = true; f.flags.failStop = true;
  const abort = new AbortController();
  const creating = f.manager.create(input(), f.config, { signal: abort.signal });
  await delay(15); abort.abort();
  await assert.rejects(creating, AggregateError);
  assert.equal(f.servers.size, 1);
  assert.ok((await readdir(f.paths("worker").parentDir)).length);
  f.flags.failStop = false;
  await f.manager.destroy("worker");
});

test("reload closes waits/connections but leaves child; new manager reconnects without restarting or replay", async t => {
  const f = await fixture(t); await f.manager.create(input(), f.config);
  const waiting = f.manager.inspect("worker", true);
  const rejected = assert.rejects(waiting);
  await f.manager.shutdown("reload"); await rejected;
  assert.equal(f.servers.size, 1);
  const replacement = new ParentManager(f.options);
  assert.deepEqual(await replacement.recover(), [{ name: "worker", connected: true }]);
  assert.equal(f.calls.filter(item => item.op === "start").length, 1);
  assert.deepEqual(f.prompts, ["original"]);
  await replacement.shutdown("quit");
  assert.equal(f.servers.size, 0);
  assert.deepEqual(await readSessionRecord(f.paths("worker").sessionFile), f.config);
  await replacement.shutdown("quit");
});

test("recovery loads only original session, isolates invalid record, no prompt or configuration overrides", async t => {
  const f = await fixture(t);
  for (const name of ["bad", "good"]) await createSubagentDirectory(f.root, "parent", name);
  await writeFile(f.paths("bad").sessionFile, "");
  await writeFile(f.paths("good").sessionFile, record(f.config));
  const results = await f.manager.recover();
  assert.equal(results.find(item => item.name === "bad")?.connected, false);
  assert.equal(results.find(item => item.name === "good")?.connected, true);
  assert.deepEqual(f.calls, [{ op: "start", name: "good", config: undefined }]);
  assert.deepEqual(f.prompts, []);
  await f.manager.recover();
  assert.equal(f.calls.length, 1);
});

test("unreachable old live child is not duplicated; fallback configuration is reported and new process stopped", async t => {
  const f = await fixture(t); await createSubagentDirectory(f.root, "parent", "live"); f.busy.add("live");
  assert.equal((await f.manager.recover())[0]?.connected, false);
  assert.deepEqual(f.calls, []);
  await createSubagentDirectory(f.root, "parent", "fallback");
  await writeFile(f.paths("fallback").sessionFile, record(f.config));
  f.flags.mismatch = true;
  const results = await f.manager.recover();
  assert.match(results.find(item => item.name === "fallback")!.error!, /configuration mismatch/);
  assert.equal(f.servers.size, 0);
  assert.ok(await readFile(f.paths("fallback").sessionFile));
});

test("destroy live/stopped records and repeated cleanup; symlink replacement and other parent preserved", async t => {
  const f = await fixture(t); await f.manager.create(input(), f.config);
  await f.manager.destroy("worker"); await f.manager.destroy("worker");
  await createSubagentDirectory(f.root, "parent", "stopped");
  await writeFile(f.paths("stopped").sessionFile, record(f.config));
  await f.manager.destroy("stopped");
  const other = await createSubagentDirectory(f.root, "other-parent", "worker");
  await writeFile(other.sessionFile, "other");
  await symlink(other.runDir, f.paths("worker").runDir);
  await assert.rejects(f.manager.destroy("worker"), /Unsafe managed/);
  assert.equal(await readFile(other.sessionFile, "utf8"), "other");
});

test("quit/new/resume/fork stop and preserve history; lifecycle factory only registers hooks", async t => {
  for (const reason of ["quit", "new", "resume", "fork"] as const) {
    const f = await fixture(t); await f.manager.create(input(), f.config);
    await Promise.all([f.manager.shutdown(reason), f.manager.shutdown(reason)]);
    assert.equal(f.calls.filter(item => item.op === "stop").length, 1);
    assert.ok(await readFile(f.paths("worker").sessionFile));
  }
  const f = await fixture(t);
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  let factories = 0;
  const lifecycle = registerParentLifecycle(pi, () => { factories++; return f.manager; });
  assert.equal(factories, 0); assert.throws(() => lifecycle.current());
  const ctx = { cwd: f.root, sessionManager: { getSessionId: () => "parent" } } as ExtensionContext;
  await handlers.get("session_start")!({}, ctx); await handlers.get("session_start")!({}, ctx);
  assert.equal(factories, 1); assert.equal(lifecycle.current(), f.manager);
  await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
});

test("Pi thinking clamp is returned as effective config; provider/model fallback still fails", async t => {
  const f = await fixture(t); f.flags.clamp = true;
  const created = await f.manager.create(input(), f.config);
  assert.equal(created.config.thinking, "off");
  assert.equal((await readSessionRecord(f.paths("worker").sessionFile)).thinking, "off");
  f.flags.clamp = false; f.flags.mismatch = true;
  await assert.rejects(f.manager.create(input("fallback"), f.config), /effective configuration/);
});

test("timeouts/cancellation cover connection setup and cancelled caller does not poison another caller", async t => {
  const f = await fixture(t); await createSubagentDirectory(f.root, "parent", "worker");
  const manager = new ParentManager({ ...f.options, connect: async (_runDir, signal) => {
    try { await delay(25, undefined, { signal }); }
    catch { throw Object.assign(new Error("cancelled"), { code: "ABORTED" }); }
    return { request: async (method): Promise<JsonValue> => method === "identity"
      ? { ...f.config, runDir: f.paths("worker").runDir, sessionFile: f.paths("worker").sessionFile, pid: 42 }
      : { state: "idle" }, close: async () => {} };
  } });
  await assert.rejects(manager.inspect("worker", false, { timeoutMs: 5 }), { code: "TIMEOUT" });
  const abort = new AbortController();
  const first = manager.inspect("worker", false, { signal: abort.signal });
  const second = manager.inspect("worker");
  abort.abort();
  await assert.rejects(first, { code: "ABORTED" });
  assert.deepEqual(await second, { state: "idle" });
  await manager.shutdown("reload");
});

test("readiness deadline also bounds a socket whose identity RPC never responds", async t => {
  const f = await fixture(t);
  const manager = new ParentManager({ ...f.options, connect: async (_runDir, signal) => ({
    request: async () => { await delay(500, undefined, { signal }); return null; }, close: async () => {},
  }) });
  await assert.rejects(manager.create(input(), f.config), { code: "READY_TIMEOUT" });
  assert.equal(f.servers.size, 0);
  await manager.shutdown("reload");
});

test("record validator rejects empty/setup-only/invalid tree/config and never rewrites files", async t => {
  const f = await fixture(t); const path = join(f.root, "record.jsonl");
  const full = record(f.config);
  for (const text of ["", "{}\n", full.split("\n").slice(0, 3).join("\n"), full.replace('"parentId":"m"', '"parentId":"absent"'), full + "broken"]) {
    await writeFile(path, text); await assert.rejects(readSessionRecord(path));
    assert.equal(await readFile(path, "utf8"), text);
  }
});
