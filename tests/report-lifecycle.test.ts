import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import type { RpcEventListener } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";
import type { ParentMessageSender } from "../src/report.ts";
import { createRpcAdapterFactory } from "../src/rpc-client.ts";
import type { ParentConfigSnapshot, PromptDisposition } from "../src/types.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

const parent: ParentConfigSnapshot = {
  cwd: "/parent", model: { provider: "p", id: "m" }, thinkingLevel: "off",
};
const spawn = { action: "spawn", name: "审查员 / Reviewer", message: "initial" } as const;
const send = { action: "send", name: spawn.name, message: "next" } as const;
const settled = { type: "agent_settled", aborted: false } as const;
const methods = (client: FakeRpcClient) => client.calls.map(({ method }) => method);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(clients = [new FakeRpcClient()]) {
  const deliveries: Parameters<ParentMessageSender>[] = [];
  let index = 0;
  const manager = new SubagentManager({
    createClient: () => clients[index++],
    sendMessage: (...args) => { deliveries.push(args); },
  });
  return { manager, clients, deliveries };
}

function assertEmpty(manager: SubagentManager, clients: FakeRpcClient[]) {
  // No public list/status API is added just for inspecting reservations in tests.
  assert.equal((manager as unknown as { records: Map<string, unknown> }).records.size, 0);
  for (const client of clients) assert.equal(client.listeners.size, 0);
}

test("only settled reads last assistant text; no event text, thinking, tool output or history is forwarded", async () => {
  const { manager, clients: [client], deliveries } = fixture();
  await manager.spawn(spawn, parent);
  client.emit({ type: "agent_start" });
  client.emit({ type: "message_update", assistantMessageEvent: {
    type: "thinking_delta", contentIndex: 0, delta: "private thinking",
  }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  client.emit({ type: "tool_execution_end", toolCallId: "t", toolName: "bash",
    result: { content: [{ type: "text", text: "tool output" }], details: {} }, isError: false });
  client.emit({ type: "agent_end", messages: [{ role: "user", content: "not the result", timestamp: 0 }], willRetry: false });
  await nextTurn(); // Drain dispatched async work, not a race-timing sleep.
  assert.equal(deliveries.length, 0);
  assert.ok(!methods(client).includes("getLastAssistantText"));
  client.text = " only final text\n第二行 ";
  client.emit(settled);
  await nextTurn();
  assert.deepEqual(deliveries, [[{
    customType: "subagent.report",
    content: `Subagent: ${spawn.name}\n\n${client.text}`,
    display: true,
  }, { deliverAs: "steer", triggerTurn: true }]]);
  assert.equal(methods(client).filter((method) => method === "getLastAssistantText").length, 1);
  assert.equal(client.listeners.size, 1);
  await manager.send({ ...send, mode: "followUp" }); // Reporting does not terminate the child.
  assert.ok(!methods(client).includes("stop"));
  await manager.shutdown();
});

test("null is explicit, empty string is preserved, and successive runs report once per settled", async () => {
  const { manager, clients: [client], deliveries } = fixture();
  await manager.spawn(spawn, parent);
  client.emit(settled);
  await nextTurn();
  assert.equal(deliveries[0][0].content, `Subagent: ${spawn.name}\n\n(No assistant text available.)`);
  for (const text of ["", "second run result"]) {
    await manager.send(send);
    client.text = text;
    client.emit(settled);
    await nextTurn();
    assert.equal(deliveries.at(-1)![0].content, `Subagent: ${spawn.name}\n\n${text}`);
  }
  assert.equal(deliveries.length, 3);
  assert.equal(methods(client).filter((method) => method === "getLastAssistantText").length, 3);
  await manager.shutdown();
});

test("many sends merge into one settled report and handled requires no settled", async () => {
  const { manager, clients: [client], deliveries } = fixture();
  client.disposition = "handled";
  assert.equal((await manager.spawn(spawn, parent)).disposition, "handled");
  assert.equal((await manager.send(send)).disposition, "handled");
  await nextTurn();
  assert.equal(deliveries.length, 0);
  assert.ok(!methods(client).includes("getLastAssistantText"));
  client.disposition = "queued";
  await Promise.all([manager.send(send), manager.send({ ...send, mode: "followUp" }), manager.send(send)]);
  client.text = "merged result";
  client.emit(settled);
  await nextTurn();
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0][1], { deliverAs: "steer", triggerTurn: true });
  await manager.shutdown();
});

test("overlapping settled callbacks each start their own read at the event boundary", { timeout: 2000 }, async (t) => {
  const { manager, clients: [client], deliveries } = fixture();
  await manager.spawn(spawn, parent);
  const reads = [deferred<string | null>(), deferred<string | null>()];
  let index = 0;
  const read = t.mock.method(client, "getLastAssistantText", () => reads[index++].promise);
  client.emit(settled);
  await manager.send(send);
  client.emit({ ...settled, aborted: true }); // Aborted settled is still a report boundary.
  assert.equal(read.mock.callCount(), 2);
  reads[1].resolve("second");
  await nextTurn();
  reads[0].resolve("first");
  await nextTurn();
  assert.deepEqual(deliveries.map(([message]) => message.content), [
    `Subagent: ${spawn.name}\n\nsecond`, `Subagent: ${spawn.name}\n\nfirst`,
  ]);
  await manager.shutdown();
});

test("sync/async read and delivery failures are caught, without retries, crash reports or removal", async (t) => {
  for (const boundary of ["read", "delivery"] as const) {
    for (const asynchronous of [false, true]) {
      await t.test(`${boundary} / ${asynchronous ? "reject" : "throw"}`, async (t) => {
        const client = new FakeRpcClient();
        const error = new Error("expected boundary failure");
        const fail = () => { if (asynchronous) return Promise.reject(error); throw error; };
        let deliveryAttempts = 0;
        let failDelivery = boundary === "delivery";
        const manager = new SubagentManager({ createClient: () => client, sendMessage() {
          deliveryAttempts++;
          if (failDelivery) return fail();
        } });
        await manager.spawn(spawn, parent);
        const read = t.mock.method(client, "getLastAssistantText", boundary === "read" ? fail : async () => "ok");
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on("unhandledRejection", onUnhandled);
        try {
          client.emit(settled); // Exactly like SDK: listener return values are ignored.
          await nextTurn();
          assert.deepEqual(unhandled, []); // Node's test runner also fails any unhandled rejection.
          assert.equal(read.mock.callCount(), 1);
          assert.equal(deliveryAttempts, boundary === "read" ? 0 : 1);
          await manager.send(send);
          assert.equal(client.listeners.size, 1);
          assert.ok(!methods(client).includes("stop"));
          read.mock.restore();
          failDelivery = false;
          client.emit(settled); // A new event works; this is not an automatic retry.
          await nextTurn();
          assert.equal(deliveryAttempts, boundary === "read" ? 1 : 2);
        } finally {
          process.off("unhandledRejection", onUnhandled);
          await manager.shutdown();
        }
      });
    }
  }
});

test("shutdown during text read drops the late result and old listeners; new runtime can reuse the name", { timeout: 2000 }, async (t) => {
  const { manager, clients: [client], deliveries } = fixture();
  await manager.spawn(spawn, parent);
  const text = deferred<string | null>();
  const read = t.mock.method(client, "getLastAssistantText", () => text.promise);
  const stale = [...client.listeners][0];
  client.emit(settled);
  assert.equal(read.mock.callCount(), 1);
  const shutdown = manager.shutdown();
  stale(settled); // Closed immediately, before the cleanup microtask.
  assert.equal(read.mock.callCount(), 1);
  await shutdown; // Does not wait for text.
  assertEmpty(manager, [client]);
  const replacement = fixture();
  await replacement.manager.spawn(spawn, parent);
  text.resolve("too late");
  await nextTurn();
  stale(settled);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(deliveries.length, 0);
  assert.equal(replacement.deliveries.length, 0);
  await replacement.manager.shutdown();
});

test("rollback during text read also drops the result even when the name is recreated", { timeout: 2000 }, async (t) => {
  const old = new FakeRpcClient();
  const { manager, deliveries } = fixture([old, new FakeRpcClient()]);
  const text = deferred<string | null>();
  const ack = deferred<PromptDisposition>();
  const entered = deferred<void>();
  t.mock.method(old, "prompt", () => { old.emit(settled); entered.resolve(); return ack.promise; });
  t.mock.method(old, "getLastAssistantText", () => text.promise);
  const spawning = assert.rejects(manager.spawn(spawn, parent), /initial failed/);
  await entered.promise;
  ack.reject(new Error("initial failed"));
  await spawning;
  await manager.spawn(spawn, parent);
  text.resolve("old result");
  await nextTurn();
  assert.equal(deliveries.length, 0);
  await manager.shutdown();
});

test("shutdown never waits for an already-started async delivery, and catches its late rejection", { timeout: 2000 }, async () => {
  const client = new FakeRpcClient();
  const delivery = deferred<void>();
  const entered = deferred<void>();
  let attempts = 0;
  const manager = new SubagentManager({ createClient: () => client, sendMessage() {
    attempts++;
    entered.resolve();
    return delivery.promise;
  } });
  await manager.spawn(spawn, parent);
  client.emit(settled);
  await entered.promise;
  await manager.shutdown();
  delivery.reject(new Error("late delivery failure"));
  await nextTurn();
  assert.equal(attempts, 1);
  assertEmpty(manager, [client]);
});

test("empty shutdown is terminal and returns the exact same promise on repeated calls", async () => {
  const { manager, clients } = fixture();
  const first = manager.shutdown();
  assert.equal(manager.shutdown(), first);
  await assert.rejects(manager.spawn(spawn, parent), /closed/);
  await assert.rejects(manager.send(send), /closed/);
  assert.equal(clients[0].calls.length, 0);
  await first;
  assert.equal(manager.shutdown(), first);
  assertEmpty(manager, clients);
});

test("parallel starting, initial-prompt and ready children are stopped without waiting for RPC completion", { timeout: 2000 }, async (t) => {
  const clients = [new FakeRpcClient(), new FakeRpcClient(), new FakeRpcClient()];
  const { manager, deliveries } = fixture(clients);
  const start = deferred<void>();
  const prompt = deferred<PromptDisposition>();
  const promptEntered = deferred<void>();
  const stopGates = clients.map(() => deferred<void>());
  const stopsEntered = deferred<void>();
  const live = new Set<FakeRpcClient>();
  let stops = 0;
  for (const [index, client] of clients.entries()) {
    t.mock.method(client, "start", async () => { live.add(client); if (index === 0) await start.promise; });
    t.mock.method(client, "stop", async () => {
      stops++;
      if (stops === clients.length) stopsEntered.resolve();
      await stopGates[index].promise;
      live.delete(client);
    });
  }
  t.mock.method(clients[1], "prompt", () => { promptEntered.resolve(); return prompt.promise; });
  const first = assert.rejects(manager.spawn(spawn, parent), /closed/);
  const second = assert.rejects(manager.spawn({ ...spawn, name: "prompting" }, parent), /closed/);
  await promptEntered.promise;
  await manager.spawn({ ...spawn, name: "ready" }, parent);
  const stale = [...clients[2].listeners][0];
  const shutdown = manager.shutdown();
  await stopsEntered.promise; // All stop calls start before *any* stop gate resolves.
  assert.equal(stops, 3);
  assert.ok(clients.every((client) => client.listeners.size === 0));
  await assert.rejects(manager.spawn({ ...spawn, name: "new" }, parent), /closed/);
  await assert.rejects(manager.send({ ...send, name: "ready" }), /closed/);
  for (const gate of stopGates) gate.resolve();
  await shutdown; // Neither start nor prompt has resolved yet.
  assert.equal(live.size, 0);
  assertEmpty(manager, clients);
  start.resolve();
  prompt.resolve("started");
  await Promise.all([first, second]);
  stale(settled);
  assert.equal(deliveries.length, 0);
  assert.equal(clients[0].calls.length, 0); // No onEvent or prompt after late start success.
  assert.equal(stops, 3); // Late continuations share completed cleanup, no duplicate stop.
  assertEmpty(manager, clients);
  assert.equal(manager.shutdown(), shutdown);
});

test("manager shutdown stops the production adapter during its pending readiness handshake", { timeout: 2000 }, async (t) => {
  const sdk = new FakeRpcClient();
  const state = deferred<typeof sdk.state>();
  const entered = deferred<void>();
  t.mock.method(sdk, "getState", () => { entered.resolve(); return state.promise; });
  const manager = new SubagentManager({
    createClient: createRpcAdapterFactory(() => sdk),
    sendMessage() { assert.fail("No report expected"); },
  });
  const spawning = assert.rejects(manager.spawn(spawn, parent), /stopped during startup/);
  await entered.promise;
  await manager.shutdown();
  assert.deepEqual(methods(sdk), ["start", "stop"]);
  assertEmpty(manager, [sdk]);
  state.resolve(sdk.state);
  await spawning;
  assert.deepEqual(methods(sdk), ["start", "stop"]);
});

test("late start/prompt rejection after shutdown is handled without restoring resources", async (t) => {
  for (const method of ["start", "prompt"] as const) {
    await t.test(method, { timeout: 2000 }, async (t) => {
      const client = new FakeRpcClient();
      const gate = deferred<never>();
      const entered = deferred<void>();
      t.mock.method(client, method, () => { entered.resolve(); return gate.promise; });
      const { manager } = fixture([client]);
      const failed = assert.rejects(manager.spawn(spawn, parent), /late failure/);
      await entered.promise;
      await manager.shutdown();
      gate.reject(new Error("late failure"));
      await failed;
      assert.equal(methods(client).filter((method) => method === "stop").length, 1);
      assertEmpty(manager, [client]);
    });
  }
});

test("reentrant shutdown from factory, subscription or initial prompt cannot leak resources", async (t) => {
  for (const boundary of ["factory", "onEvent", "prompt"] as const) {
    await t.test(boundary, { timeout: 2000 }, async (t) => {
      const client = new FakeRpcClient();
      let manager: SubagentManager;
      if (boundary === "onEvent") t.mock.method(client, "onEvent", (listener: RpcEventListener) => {
        client.listeners.add(listener);
        void manager.shutdown();
        return () => { client.listeners.delete(listener); };
      });
      if (boundary === "prompt") t.mock.method(client, "prompt", async () => {
        void manager.shutdown();
        return "started" as const;
      });
      manager = new SubagentManager({ createClient() {
        if (boundary === "factory") void manager.shutdown();
        return client;
      }, sendMessage() { assert.fail("No report expected"); } });
      await assert.rejects(manager.spawn(spawn, parent), /closed/);
      await manager.shutdown();
      assert.equal(methods(client).filter((method) => method === "stop").length, 1);
      assertEmpty(manager, [client]);
      if (boundary === "factory") assert.deepEqual(methods(client), ["stop"]);
      if (boundary === "onEvent") assert.ok(!methods(client).includes("prompt"));
    });
  }
});

test("rollback and shutdown share cleanup; a failing stop/unsubscribe cannot block other children", { timeout: 2000 }, async (t) => {
  const broken = new FakeRpcClient();
  const healthy = new FakeRpcClient();
  const { manager, deliveries } = fixture([broken, healthy]);
  const initial = new Error("initial rejected");
  const stopEntered = deferred<void>();
  const stopped = deferred<void>();
  let stale!: RpcEventListener;
  t.mock.method(broken, "onEvent", (listener: RpcEventListener) => {
    stale = listener;
    broken.listeners.add(listener);
    return () => { broken.listeners.delete(listener); throw new Error("unsubscribe failed"); };
  });
  t.mock.method(broken, "prompt", async () => { throw initial; });
  const stop = t.mock.method(broken, "stop", async () => {
    stopEntered.resolve();
    await stopped.promise;
    throw new Error("stop failed");
  });
  const spawning = assert.rejects(manager.spawn(spawn, parent), (error) => error === initial);
  await stopEntered.promise;
  await manager.spawn({ ...spawn, name: "healthy" }, parent);
  const shutdown = manager.shutdown();
  await nextTurn();
  assert.deepEqual(methods(healthy), ["start", "onEvent", "prompt", "stop"]);
  assert.equal(healthy.listeners.size, 0);
  stopped.resolve();
  await Promise.all([shutdown, spawning]);
  stale(settled);
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(deliveries.length, 0);
  assertEmpty(manager, [broken, healthy]);
});

test("already-exited children retain SDK request errors, with no exit notifications or recovery", async (t) => {
  const { manager, clients: [client], deliveries } = fixture();
  await manager.spawn(spawn, parent);
  const error = new Error("Agent process exited");
  const prompt = t.mock.method(client, "prompt", async () => { throw error; });
  await assert.rejects(manager.send(send), (actual) => actual === error);
  client.emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider failed" });
  await nextTurn();
  assert.equal(prompt.mock.callCount(), 1);
  assert.equal(deliveries.length, 0);
  assert.equal(client.listeners.size, 1); // One settled listener, not an additional exit listener.
  await assert.rejects(manager.spawn(spawn, parent), /already exists/);
  await manager.shutdown();
  assertEmpty(manager, [client]);
});

test("in-flight send acceptance after shutdown cannot reactivate a record", { timeout: 2000 }, async (t) => {
  const { manager, clients: [client] } = fixture();
  await manager.spawn(spawn, parent);
  const ack = deferred<PromptDisposition>();
  t.mock.method(client, "prompt", () => ack.promise);
  const sending = assert.rejects(manager.send(send), /closed/);
  await manager.shutdown();
  ack.resolve("queued");
  await sending;
  assertEmpty(manager, [client]);
});
