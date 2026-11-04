import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { ParentManager } from "../src/parent-manager.ts";
import { getSubagentPaths, type SubagentPaths } from "../src/paths.ts";
import type { ProcessDriver } from "../src/process-driver.ts";
import { readSessionRecord, type EffectiveConfig } from "../src/session-record.ts";
import { createSubagentTool, type SubagentInput } from "../src/subagent-tool.ts";

interface Stats { idle: boolean; reads: number; deliveries: Array<{ prompt: string; delivery: unknown }> }
class ControlledChild {
  readonly process: ChildProcess;
  readonly exited: Promise<unknown>;
  readonly ready: Promise<void>;
  private id = 0;
  private pending = new Map<number, { resolve(value: Stats): void; reject(error: Error): void }>();
  stderr = "";
  constructor(paths: SubagentPaths, config: EffectiveConfig, xdg: string) {
    // Deliberately do not inherit credentials, PI_* state or the user's agent dir.
    this.process = fork(new URL("./fixtures/fake-pi.ts", import.meta.url), [], {
      env: { PATH: process.env.PATH, HOME: paths.agentDir, XDG_RUNTIME_DIR: xdg,
        PI_CODING_AGENT_DIR: paths.agentDir, PI_SUBAGENT_RUN_DIR: paths.runDir,
        PI_SUBAGENT_SESSION_FILE: paths.sessionFile, TEST_CONFIG: JSON.stringify(config) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.process.stderr!.on("data", chunk => { this.stderr += chunk; });
    this.exited = once(this.process, "exit");
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fake Pi startup timeout: ${this.stderr}`)), 10000);
      const finish = () => clearTimeout(timer);
      this.process.once("exit", () => { finish(); reject(new Error(`Fake Pi exited: ${this.stderr}`)); });
      this.process.on("message", (message: any) => {
        if (message.ready) { finish(); resolve(); return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      });
      this.process.once("error", error => { finish(); reject(error); });
    });
    this.process.once("exit", () => {
      for (const request of this.pending.values()) request.reject(new Error("Fake Pi exited"));
      this.pending.clear();
    });
  }
  command(command: string, text?: string): Promise<Stats> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.process.send({ id, command, text }, error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await this.command("stop");
    await this.exited;
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-integration-"));
  const xdg = join(root, "xdg"); await mkdir(xdg, { mode: 0o700 });
  const config: EffectiveConfig = { provider: "test", model: "synthetic", thinking: "off", cwd: root };
  const children = new Map<string, ControlledChild>();
  const allChildren: ControlledChild[] = [];
  const managers: ParentManager[] = [];
  const starts: Array<{ runDir: string; override: boolean }> = [];
  const flags = { failStart: false, failStop: false };
  const driver: ProcessDriver = {
    async start(paths, override) {
      if (flags.failStart) throw new Error("Injected launcher failure");
      assert.equal(await this.isRunning(paths), false, "never launch a duplicate");
      starts.push({ runDir: paths.runDir, override: !!override });
      const child = new ControlledChild(paths, override ?? await readSessionRecord(paths.sessionFile), xdg);
      children.set(paths.runDir, child); allChildren.push(child);
      await child.ready;
    },
    async isRunning(paths) {
      const child = children.get(paths.runDir);
      return !!child && child.process.exitCode === null && child.process.signalCode === null;
    },
    async stop(paths) {
      if (flags.failStop) throw new Error("Injected cleanup failure");
      await children.get(paths.runDir)?.stop();
    },
  };
  function manager(parentSessionId = "parent") {
    const manager = new ParentManager({ agentDir: root, parentSessionId, driver,
      transport: { address: { xdgRuntimeDir: xdg } }, readyTimeoutMs: 10000, persistenceTimeoutMs: 1000 });
    managers.push(manager); return manager;
  }
  const paths = (name = "worker", parent = "parent") => getSubagentPaths(root, parent, name);
  const child = (name = "worker", parent = "parent") => children.get(paths(name, parent).runDir)!;
  t.after(async () => {
    flags.failStop = false;
    try {
      for (const manager of managers) await manager.shutdown("quit").catch(() => {});
      for (const child of allChildren) await child.stop();
      assert.ok(allChildren.every(child => child.process.exitCode !== null || child.process.signalCode !== null));
      assert.deepEqual(await readdir(join(xdg, "pi-subagent")).catch(() => []), [], "no residual sockets");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const tool = (manager: ParentManager) => {
    const definition = createSubagentTool(() => manager, () => config);
    return (input: SubagentInput, signal?: AbortSignal) => definition.execute("integration", input, signal, undefined, {} as Parameters<typeof definition.execute>[4]);
  };
  return { root, config, manager, paths, child, starts, flags, tool, driver };
}
const spawn = { operation: "spawn", name: "worker", prompt: "initial 中文 task" } as const;

test("controlled process: tool → manager → production child entry/socket → native history → latest reply → stop", async t => {
  const f = await fixture(t); const manager = f.manager(); const call = f.tool(manager);
  const created = await call(spawn);
  assert.equal(created.isError, false);
  assert.deepEqual(created.details.data, { name: "worker", config: f.config, invoked: true });
  assert.deepEqual(await call({ operation: "status", name: "worker" }).then(r => r.details.data), { state: "working" });
  assert.deepEqual((await call({ operation: "list" })).details.data, [{ name: "worker", status: { available: true, workState: "working" } }]);
  assert.equal((await f.child().command("stats")).reads, 0, "status/list never read reply");
  for (const input of [
    { operation: "send", name: "worker", prompt: "default steering" },
    { operation: "send", name: "worker", prompt: "follow-up", followUp: true },
  ] as const) assert.equal((await call(input)).isError, false);
  const stats = await f.child().command("stats");
  assert.deepEqual(stats.deliveries, [
    { prompt: spawn.prompt, delivery: null },
    { prompt: "default steering", delivery: { deliverAs: "steer" } },
    { prompt: "follow-up", delivery: { deliverAs: "followUp" } },
  ]);
  const waiting = call({ operation: "wait", name: "worker" });
  await f.child().command("settle", "最新 reply **原文**");
  const result = await waiting;
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.data, { state: "idle", reply: { text: "最新 reply **原文**", stopReason: "stop" } });
  assert.deepEqual((await call({ operation: "status", name: "worker" })).details.data, { state: "idle" });
  await call({ operation: "send", name: "worker", prompt: "new work", followUp: true });
  assert.deepEqual((await f.child().command("stats")).deliveries.at(-1), { prompt: "new work", delivery: null });
  // stop removes extra run records too, not just session.jsonl.
  await writeFile(join(f.paths().runDir, "extra-test-record"), "owned");
  assert.equal((await call({ operation: "stop", name: "worker" })).isError, false);
  await assert.rejects(readFile(f.paths().sessionFile), { code: "ENOENT" });
  await assert.rejects(readdir(f.paths().runDir), { code: "ENOENT" });
  assert.equal(await f.driver.isRunning(f.paths()), false);
});

test("controlled process: cancel/timeout end only their wait; late settled reads only the surviving request", async t => {
  const f = await fixture(t); const manager = f.manager(); const call = f.tool(manager);
  await call(spawn);
  const abort = new AbortController();
  const cancelled = call({ operation: "wait", name: "worker" }, abort.signal);
  const timedOut = call({ operation: "wait", name: "worker", timeout: 0.1 });
  const surviving = call({ operation: "wait", name: "worker" });
  await delay(30); abort.abort();
  const [a, b] = await Promise.all([cancelled, timedOut]);
  assert.equal(a.isError, true); assert.equal(a.details.phase, "cancelled");
  assert.equal(b.isError, true); assert.equal(b.details.phase, "timeout");
  await delay(30); // allow cancellation frames to reach the child before settled
  assert.deepEqual(await manager.status("worker"), { state: "working" });
  assert.equal(await f.driver.isRunning(f.paths()), true);
  assert.equal((await f.child().command("stats")).reads, 0);
  await f.child().command("settle", "continued after cancellation");
  assert.equal((await surviving).isError, false);
  assert.equal((await f.child().command("stats")).reads, 1, "no late result generated for either cancelled request");
});

test("controlled process: disconnect and unexpected exit interrupt wait; launch/cleanup failures never report success", async t => {
  const f = await fixture(t); const manager = f.manager(); const call = f.tool(manager);
  await call(spawn);
  const waiting = call({ operation: "wait", name: "worker" });
  await delay(30); await f.child().command("disconnect");
  assert.equal((await waiting).isError, true);
  assert.equal(await f.driver.isRunning(f.paths()), true, "connection loss is not process exit");
  assert.equal((await manager.list())[0]!.status.available, false);
  await manager.stop("worker");
  await call(spawn);
  const interrupted = call({ operation: "wait", name: "worker" });
  await delay(30);
  f.child().process.kill("SIGKILL"); // this exact test-owned fork only; leaves a stale socket
  await f.child().exited;
  assert.equal((await interrupted).isError, true);
  await manager.stop("worker"); // confirms dead endpoint safely cleaned
  f.flags.failStart = true;
  assert.equal((await call(spawn)).isError, true);
  await assert.rejects(readdir(f.paths().runDir), { code: "ENOENT" });
  f.flags.failStart = false;
  await call(spawn);
  f.flags.failStop = true;
  const failed = await call({ operation: "stop", name: "worker" });
  assert.equal(failed.isError, true); assert.equal(failed.details.phase, "error");
  assert.ok(await readFile(f.paths().sessionFile));
  assert.equal(await f.driver.isRunning(f.paths()), true);
  f.flags.failStop = false;
  await manager.stop("worker"); await manager.stop("worker");
});

test("controlled process: reload retains running child; early stop restores original history idle with no replay; parent names isolated", async t => {
  const f = await fixture(t); const first = f.manager();
  await first.spawn(spawn, f.config);
  const other = f.manager("other-parent");
  await other.spawn(spawn, f.config);
  const otherPid = f.child("worker", "other-parent").process.pid;
  await assert.rejects(first.spawn(spawn, f.config), { code: "EEXIST" });
  const waiting = first.wait("worker");
  const rejected = assert.rejects(waiting);
  await first.shutdown("reload"); await rejected;
  assert.equal(await f.driver.isRunning(f.paths()), true);
  const reloaded = f.manager();
  assert.deepEqual(await reloaded.recover(), [{ name: "worker", connected: true }]);
  await Promise.all([reloaded.recover(), reloaded.recover()]);
  assert.equal(f.starts.length, 2, "reload/repeated recovery never duplicates processes");
  const original = await readFile(f.paths().sessionFile, "utf8");
  assert.ok(!original.includes('"role":"assistant"'), "stopped before first assistant");
  await reloaded.shutdown("new");
  assert.equal(await f.driver.isRunning(f.paths()), false);
  assert.equal(await readFile(f.paths().sessionFile, "utf8"), original);
  const restored = f.manager();
  assert.deepEqual(await restored.recover(), [{ name: "worker", connected: true }]);
  assert.equal(f.starts.at(-1)!.override, false);
  assert.deepEqual(await restored.wait("worker"), { state: "idle", reply: null });
  assert.deepEqual((await f.child().command("stats")).deliveries, []);
  assert.equal(await readFile(f.paths().sessionFile, "utf8"), original);
  await restored.stop("worker");
  assert.equal(f.child("worker", "other-parent").process.pid, otherPid);
  assert.deepEqual(await other.status("worker"), { state: "working" });
  await other.stop("worker");
});
