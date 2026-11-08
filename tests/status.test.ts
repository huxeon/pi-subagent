import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { SubagentManager } from "../src/manager.ts";
import type { PromptDisposition, SubagentStatus } from "../src/types.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

const spawn = { action: "spawn", name: "reviewer", message: "task" } as const;
const send = { action: "send", name: spawn.name, message: "more" } as const;
const parent = { cwd: "/work", model: { provider: "p", id: "m" }, thinkingLevel: "low" } as const;
const start = { type: "agent_start" } as const;
const settled = { type: "agent_settled", aborted: false } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(clients = [new FakeRpcClient()]) {
  const snapshots: (readonly SubagentStatus[])[] = [];
  const manager = new SubagentManager({
    createClient: () => clients.shift()!,
    sendMessage() {},
    onStatusChange: (statuses) => { snapshots.push(statuses); },
  });
  return { manager, snapshots };
}
const status = (state: SubagentStatus["state"], name: string = spawn.name) => ({ name, state });

test("activity changes immediately on events, independently of send acceptance; no status getState", async (t) => {
  const client = new FakeRpcClient();
  const { manager, snapshots } = fixture([client]);
  t.after(() => manager.shutdown());
  await manager.spawn(spawn, parent);
  assert.deepEqual(snapshots, [[status("idle")]], "acceptance alone does not imply running");
  const ack = deferred<PromptDisposition>();
  t.mock.method(client, "prompt", () => ack.promise);
  const sending = manager.send(send);
  client.emit(start);
  assert.deepEqual(snapshots.at(-1), [status("running")]);
  client.emit({ type: "agent_end", messages: [], willRetry: false });
  client.emit(start); // Continuation or retry must not flicker idle or cause redundant updates.
  assert.equal(snapshots.length, 2);
  client.emit(settled);
  assert.deepEqual(snapshots.at(-1), [status("idle")]);
  ack.resolve("started");
  await sending;
  assert.equal(snapshots.length, 3, "late acceptance cannot overwrite settled");
  assert.equal(client.calls.some((c) => c.method === "getState"), false);
  assert.deepEqual(snapshots[0], [status("idle")], "old snapshots are not mutated");
});

test("spawn hides starting records, retains early events, and reveals the latest state only on success", async (t) => {
  for (const finishEarly of [false, true]) {
    const client = new FakeRpcClient();
    const { manager, snapshots } = fixture([client]);
    t.after(() => manager.shutdown());
    const ack = deferred<PromptDisposition>();
    const entered = deferred<void>();
    t.mock.method(client, "prompt", () => { entered.resolve(); return ack.promise; });
    const spawning = manager.spawn(spawn, parent);
    await entered.promise;
    client.emit(start);
    if (finishEarly) client.emit(settled);
    assert.deepEqual(snapshots, []);
    ack.resolve("started");
    await spawning;
    assert.deepEqual(snapshots, [[status(finishEarly ? "idle" : "running")]]);
  }
});

test("failed initial acceptance never reveals a record, including early running events", async (t) => {
  const client = new FakeRpcClient();
  const { manager, snapshots } = fixture([client, new FakeRpcClient()]);
  t.after(() => manager.shutdown());
  t.mock.method(client, "prompt", async () => { client.emit(start); throw new Error("submission failed"); });
  await assert.rejects(manager.spawn(spawn, parent), /submission failed/);
  assert.deepEqual(snapshots, []);
  await manager.spawn(spawn, parent);
  assert.deepEqual(snapshots, [[status("idle")]], "released name can be recreated");
});

test("all acceptance dispositions and rejected sends leave activity unchanged without events", async (t) => {
  const client = new FakeRpcClient();
  client.disposition = "handled";
  const { manager, snapshots } = fixture([client]);
  t.after(() => manager.shutdown());
  await manager.spawn(spawn, parent);
  for (const running of [false, true]) {
    if (running) client.emit(start);
    const before = snapshots.length;
    for (const disposition of ["started", "queued", "handled"] as const) {
      client.disposition = disposition;
      await manager.send(send);
    }
    assert.equal(snapshots.length, before);
    assert.deepEqual(snapshots.at(-1), [status(running ? "running" : "idle")]);
  }
  t.mock.method(client, "prompt", async () => { throw new Error("compaction"); });
  await assert.rejects(manager.send(send), /compaction/);
  assert.deepEqual(snapshots.at(-1), [status("running")]);
});

test("settled becomes idle before result reading completes or fails, and before delivery fails", async (t) => {
  const client = new FakeRpcClient();
  const snapshots: (readonly SubagentStatus[])[] = [];
  const result = deferred<string | null>();
  t.mock.method(client, "getLastAssistantText", () => result.promise);
  const manager = new SubagentManager({ createClient: () => client,
    sendMessage() { throw new Error("delivery failed"); },
    onStatusChange: (s) => { snapshots.push(s); } });
  t.after(() => manager.shutdown());
  await manager.spawn(spawn, parent);
  client.emit(start);
  client.emit(settled);
  assert.deepEqual(snapshots.at(-1), [status("idle")]);
  result.reject(new Error("read failed"));
  await nextTurn();
  t.mock.method(client, "getLastAssistantText", async () => "result");
  client.emit(start);
  client.emit({ ...settled, aborted: true });
  assert.deepEqual(snapshots.at(-1), [status("idle")]);
  await nextTurn();
  assert.equal(snapshots.length, 5);
});

test("visible snapshots use reservation order even when spawn acknowledgements arrive out of order", async (t) => {
  const clients = [new FakeRpcClient(), new FakeRpcClient()];
  const { manager, snapshots } = fixture([...clients]);
  t.after(() => manager.shutdown());
  const ack = deferred<PromptDisposition>();
  const entered = deferred<void>();
  t.mock.method(clients[0], "prompt", () => { entered.resolve(); return ack.promise; });
  const first = manager.spawn(spawn, parent);
  await entered.promise;
  await manager.spawn({ ...spawn, name: "second" }, parent);
  assert.deepEqual(snapshots.at(-1), [status("idle", "second")]);
  clients[0].emit(start);
  ack.resolve("started");
  await first;
  assert.deepEqual(snapshots.at(-1), [status("running"), status("idle", "second")]);
  clients[1].emit(start);
  assert.deepEqual(snapshots.at(-1), [status("running"), status("running", "second")]);
});

test("shutdown clears synchronously, drops stale/starting events and cannot republish on late acceptance", async (t) => {
  const client = new FakeRpcClient();
  const { manager, snapshots } = fixture([client]);
  await manager.spawn(spawn, parent);
  client.emit(start);
  const stale = [...client.listeners][0];
  const stopping = deferred<void>();
  t.mock.method(client, "stop", () => stopping.promise);
  const shutdown = manager.shutdown();
  assert.deepEqual(snapshots.at(-1), []);
  const count = snapshots.length;
  stale(start);
  stale(settled);
  stopping.resolve();
  await shutdown;
  await manager.shutdown();
  assert.equal(snapshots.length, count);

  const starting = new FakeRpcClient();
  const other = fixture([starting]);
  const ack = deferred<PromptDisposition>();
  const entered = deferred<void>();
  t.mock.method(starting, "prompt", () => { entered.resolve(); return ack.promise; });
  const spawning = other.manager.spawn(spawn, parent);
  const rejected = assert.rejects(spawning, /closed/);
  await entered.promise;
  const late = [...starting.listeners][0];
  await other.manager.shutdown();
  late(start);
  ack.resolve("started");
  await rejected;
  assert.deepEqual(other.snapshots, [[]]);
});

test("presentation errors cannot fail spawn, event reporting, send, or shutdown", async () => {
  const client = new FakeRpcClient();
  let reports = 0;
  const manager = new SubagentManager({ createClient: () => client,
    sendMessage() { reports++; }, onStatusChange() { throw new Error("UI failed"); } });
  await manager.spawn(spawn, parent);
  client.emit(start);
  client.emit(settled);
  await nextTurn();
  assert.equal(reports, 1);
  await manager.send(send);
  await manager.shutdown();
  assert.equal(client.calls.filter((c) => c.method === "stop").length, 1);
});
