import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonAgentSessionEvent, RpcEventListener } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "../src/manager.ts";
import type { ParentMessageSender } from "../src/report.ts";
import type {
  ParentConfigSnapshot, PromptDisposition, ResolvedChildConfig, SendInput, SpawnInput,
} from "../src/types.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

const spawn: SpawnInput = { action: "spawn", name: "Reviewer", message: " initial task \n" };
const send: SendInput = { action: "send", name: "Reviewer", message: " next task \n" };
const parent: ParentConfigSnapshot = {
  cwd: "/parent/workspace", model: { provider: "parent-p", id: "parent-m" }, thinkingLevel: "medium",
};
const settled = { type: "agent_settled", aborted: false } as const;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(factory: (config: ResolvedChildConfig) => FakeRpcClient = () => new FakeRpcClient()) {
  const configs: ResolvedChildConfig[] = [];
  const clients: FakeRpcClient[] = [];
  const events: Parameters<ParentMessageSender>[] = [];
  const manager = new SubagentManager({
    createClient(config) {
      configs.push(config);
      const client = factory(config);
      clients.push(client);
      return client;
    },
    sendMessage(...args) { events.push(args); },
  });
  return { manager, configs, clients, events };
}

const methods = (client: FakeRpcClient) => client.calls.map((call) => call.method);

test("spawn waits for acceptance, never settled, and preserves every disposition", { timeout: 2000 }, async (t) => {
  for (const disposition of ["started", "queued", "handled"] as const) {
    await t.test(disposition, async (t) => {
      const client = new FakeRpcClient();
      const acceptance = deferred<PromptDisposition>();
      const entered = deferred<void>();
      const prompt = t.mock.method(client, "prompt", () => {
        assert.equal(client.listeners.size, 1);
        entered.resolve();
        return acceptance.promise;
      });
      const { manager } = fixture(() => client);
      let returned = false;
      const spawning = manager.spawn(spawn, parent).then((value) => { returned = true; return value; });
      await entered.promise;
      assert.equal(returned, false);
      assert.deepEqual(prompt.mock.calls[0].arguments, [spawn.message]);
      acceptance.resolve(disposition);
      assert.deepEqual(await spawning, { name: spawn.name, disposition });
      // No settled event has been emitted, even for handled. Child remains usable.
      assert.deepEqual(await manager.send(send), { name: send.name, disposition });
      assert.deepEqual(methods(client), ["start", "onEvent"]);
      assert.equal(client.listeners.size, 1);
    });
  }
});

test("same-name concurrent spawn loses before creating or cleaning any resources", { timeout: 2000 }, async (t) => {
  const client = new FakeRpcClient();
  const started = deferred<void>();
  t.mock.method(client, "start", () => started.promise);
  const { manager, clients } = fixture(() => client);
  const first = manager.spawn(spawn, parent);
  await assert.rejects(manager.spawn(spawn, parent), /already exists/);
  assert.equal(clients.length, 1);
  assert.equal(client.calls.length, 0);
  await assert.rejects(manager.send(send), /not ready/);
  started.resolve();
  await first;
  await assert.rejects(manager.spawn(spawn, parent), /already exists/);
  await manager.send(send); // Neither rejected duplicate removed the winning record.
  assert.equal(clients.length, 1);
  assert.deepEqual(methods(client), ["onEvent", "prompt", "prompt"]);
});

test("the name is reserved even before a reentrant synchronous factory", async () => {
  const client = new FakeRpcClient();
  let duplicate: Promise<unknown> | undefined;
  let manager: SubagentManager;
  let creations = 0;
  manager = new SubagentManager({
    createClient() {
      creations++;
      if (creations === 1) duplicate = assert.rejects(manager.spawn(spawn, parent), /already exists/);
      return client;
    },
    sendMessage() { assert.fail("No settled event was emitted"); },
  });
  await manager.spawn(spawn, parent);
  await duplicate;
  assert.equal(creations, 1);
});

test("different names start concurrently and can finish in reverse order", { timeout: 2000 }, async (t) => {
  const gates = [deferred<void>(), deferred<void>()];
  let index = 0;
  const { manager, clients } = fixture(() => {
    const client = new FakeRpcClient();
    const gate = gates[index++];
    t.mock.method(client, "start", () => gate.promise);
    return client;
  });
  const first = manager.spawn(spawn, parent);
  const second = manager.spawn({ ...spawn, name: "other" }, parent);
  assert.equal(clients.length, 2);
  gates[1].resolve();
  assert.deepEqual(await second, { name: "other", disposition: "started" });
  assert.equal(clients[0].listeners.size, 0);
  gates[0].resolve();
  await first;
  assert.equal(clients[0].listeners.size, 1);
});

test("each manager has independent exact name keys", async () => {
  const first = fixture();
  const second = fixture();
  await Promise.all([first.manager.spawn(spawn, parent), second.manager.spawn(spawn, parent)]);
  for (const name of ["reviewer", " Reviewer ", "../a/b", "__proto__", "子代理🔎"]) {
    await first.manager.spawn({ ...spawn, name }, parent);
    assert.deepEqual(await first.manager.send({ ...send, name }), { name, disposition: "started" });
  }
  assert.equal(first.clients.length, 6);
  assert.equal(second.clients.length, 1);
  assert.notEqual(first.clients[0], second.clients[0]);
});

test("resolved model pair, independent thinking, and cwd reach the client factory", async () => {
  const { manager, configs } = fixture();
  let index = 0;
  for (const pair of [undefined, { provider: "child-p", model: "child-m" }]) {
    for (const thinking of [undefined, "high"] as const) {
      await manager.spawn({ ...spawn, name: String(index++), ...pair, ...(thinking ? { thinking } : {}) }, parent);
      assert.deepEqual(configs.at(-1), {
        cwd: parent.cwd, provider: pair?.provider ?? "parent-p", model: pair?.model ?? "parent-m",
        thinking: thinking ?? "medium",
      });
    }
  }
  await manager.spawn({ ...spawn, provider: "p", model: "m", thinking: "max" }, {
    cwd: "/explicit",
    get model(): never { throw new Error("must not read model"); },
    get thinkingLevel(): never { throw new Error("must not read thinking"); },
  });
  assert.deepEqual(configs.at(-1), { cwd: "/explicit", provider: "p", model: "m", thinking: "max" });
});

test("spawn snapshots config and message before async startup, later spawns take fresh values", { timeout: 2000 }, async (t) => {
  const started = deferred<void>();
  const first = new FakeRpcClient();
  t.mock.method(first, "start", () => started.promise);
  let creations = 0;
  const { manager, configs } = fixture(() => creations++ === 0 ? first : new FakeRpcClient());
  const snapshot = { cwd: "/first", model: { provider: "first-p", id: "first-m" }, thinkingLevel: "low" as "low" | "high" };
  const input = { ...spawn };
  const spawning = manager.spawn(input, snapshot);
  snapshot.cwd = "/second";
  snapshot.model.provider = "second-p";
  snapshot.model.id = "second-m";
  snapshot.thinkingLevel = "high";
  input.name = "changed";
  input.message = "changed message";
  started.resolve();
  assert.deepEqual(await spawning, { name: spawn.name, disposition: "started" });
  assert.deepEqual(configs[0], { cwd: "/first", provider: "first-p", model: "first-m", thinking: "low" });
  assert.deepEqual(first.calls.at(-1), { method: "prompt", args: [spawn.message] });
  await manager.spawn(input, snapshot);
  assert.deepEqual(configs[1], { cwd: "/second", provider: "second-p", model: "second-m", thinking: "high" });
  await manager.send(send); // Parent changes do not affect the existing child.
  assert.equal(configs.length, 2);
});

test("fast settled before prompt acknowledgement reports without waiting for spawn", { timeout: 2000 }, async (t) => {
  const client = new FakeRpcClient();
  const acceptance = deferred<PromptDisposition>();
  const delivered = deferred<void>();
  client.text = "fast result";
  t.mock.method(client, "prompt", () => {
    assert.equal(client.listeners.size, 1);
    client.emit({ type: "agent_start" });
    client.emit(settled);
    return acceptance.promise;
  });
  const manager = new SubagentManager({
    createClient: () => client,
    sendMessage(message) {
      assert.equal(message.content, "Subagent: Reviewer\n\nfast result");
      delivered.resolve();
    },
  });
  const spawning = manager.spawn(spawn, parent);
  await delivered.promise;
  await assert.rejects(manager.send(send), /not ready/);
  assert.deepEqual(methods(client), ["start", "onEvent", "getLastAssistantText"]);
  acceptance.resolve("started");
  await spawning;
  await manager.shutdown();
});

test("send while initial acceptance is pending fails explicitly rather than queueing", { timeout: 2000 }, async (t) => {
  const client = new FakeRpcClient();
  const acceptance = deferred<PromptDisposition>();
  const entered = deferred<void>();
  const prompt = t.mock.method(client, "prompt", () => { entered.resolve(); return acceptance.promise; });
  const { manager } = fixture(() => client);
  const spawning = manager.spawn(spawn, parent);
  await entered.promise;
  await assert.rejects(manager.send(send), /not ready/);
  await assert.rejects(manager.spawn(spawn, parent), /already exists/);
  assert.equal(prompt.mock.callCount(), 1);
  acceptance.resolve("handled");
  await spawning;
  await manager.send(send);
  assert.equal(prompt.mock.callCount(), 2);
});

test("factory failure releases its reservation so the name can be recreated", async () => {
  const error = new Error("factory failed");
  let creations = 0;
  const { manager, clients } = fixture(() => {
    if (creations++ === 0) throw error;
    return new FakeRpcClient();
  });
  await assert.rejects(manager.spawn(spawn, parent), (actual) => actual === error);
  await assert.rejects(manager.send(send), /Unknown subagent/);
  await manager.spawn(spawn, parent);
  assert.equal(clients.length, 1);
});

test("start, subscription, and initial prompt failures stop the child and allow recreation", async (t) => {
  for (const method of ["start", "onEvent", "prompt"] as const) {
    await t.test(method, async (t) => {
      const client = new FakeRpcClient();
      const error = new Error(`${method} failed`);
      const fail = t.mock.method(client, method, () => { throw error; });
      let creations = 0;
      const { manager, events } = fixture(() => creations++ === 0 ? client : new FakeRpcClient());
      await assert.rejects(manager.spawn(spawn, parent), (actual) => actual === error);
      assert.equal(fail.mock.callCount(), 1);
      assert.equal(client.listeners.size, 0);
      assert.equal(methods(client).filter((name) => name === "stop").length, 1);
      assert.ok(!methods(client).includes("prompt"));
      await assert.rejects(manager.send(send), /Unknown subagent/);
      await manager.spawn(spawn, parent);
      client.emit(settled);
      assert.equal(events.length, 0);
      await manager.send(send);
    });
  }
});

test("async start failure cleans only its own child and releases the reserved name", { timeout: 2000 }, async (t) => {
  const failed = new FakeRpcClient();
  const startup = deferred<void>();
  const error = new Error("readiness failed");
  t.mock.method(failed, "start", () => startup.promise);
  let creations = 0;
  const { manager, clients } = fixture(() => creations++ === 0 ? failed : new FakeRpcClient());
  const spawning = manager.spawn(spawn, parent);
  const rejected = assert.rejects(spawning, (actual) => actual === error);
  await manager.spawn({ ...spawn, name: "other" }, parent);
  startup.reject(error);
  await rejected;
  assert.deepEqual(methods(failed), ["stop"]); // No subscription/prompt before readiness.
  assert.deepEqual(await manager.send({ ...send, name: "other" }), { name: "other", disposition: "started" });
  assert.ok(!methods(clients[1]).includes("stop"));
  await manager.spawn(spawn, parent);
  assert.equal(clients.length, 3);
});

test("async initial prompt rejection unsubscribes before stopping and holds the name through cleanup", { timeout: 2000 }, async (t) => {
  const client = new FakeRpcClient();
  const acceptance = deferred<PromptDisposition>();
  const entered = deferred<void>();
  const stopEntered = deferred<void>();
  const stopped = deferred<void>();
  const error = new Error("Cannot submit a prompt while compaction is in progress");
  const prompt = t.mock.method(client, "prompt", () => { entered.resolve(); return acceptance.promise; });
  t.mock.method(client, "stop", () => {
    assert.equal(client.listeners.size, 0);
    stopEntered.resolve();
    return stopped.promise;
  });
  let creations = 0;
  const { manager, events } = fixture(() => creations++ === 0 ? client : new FakeRpcClient());
  const spawning = manager.spawn(spawn, parent);
  const rejected = assert.rejects(spawning, (actual) => actual === error);
  await entered.promise;
  const staleListener = [...client.listeners][0];
  acceptance.reject(error);
  await stopEntered.promise;
  await assert.rejects(manager.spawn(spawn, parent), /already exists/);
  await assert.rejects(manager.send(send), /not ready/);
  stopped.resolve();
  await rejected;
  assert.equal(prompt.mock.callCount(), 1); // No compaction retry.
  await manager.spawn(spawn, parent);
  staleListener(settled); // A delayed callback for the old child cannot reach the consumer.
  assert.equal(events.length, 0);
  await manager.send(send);
});

test("cleanup errors neither mask the submission error nor retain the name", async (t) => {
  const client = new FakeRpcClient();
  const error = new Error("initial prompt failed");
  let staleListener: ((event: JsonAgentSessionEvent) => void) | undefined;
  t.mock.method(client, "onEvent", (listener: RpcEventListener) => {
    staleListener = listener;
    return () => { throw new Error("unsubscribe failed"); };
  });
  t.mock.method(client, "prompt", async () => { throw error; });
  const stop = t.mock.method(client, "stop", async () => { throw new Error("stop failed"); });
  let creations = 0;
  const { manager, events } = fixture(() => creations++ === 0 ? client : new FakeRpcClient());
  await assert.rejects(manager.spawn(spawn, parent), (actual) => actual === error);
  assert.equal(stop.mock.callCount(), 1);
  await manager.spawn(spawn, parent);
  staleListener!(settled);
  assert.equal(events.length, 0);
  await manager.send(send);
});

test("invalid inputs/config and unknown names fail without creating or reserving resources", async () => {
  const { manager, clients } = fixture();
  for (const invalid of [
    { ...spawn, name: " " }, { ...spawn, message: "" }, { ...spawn, provider: "p" },
    { ...spawn, model: "m" }, { ...spawn, thinking: "invalid" }, { ...spawn, action: "send" },
  ]) {
    await assert.rejects(manager.spawn(invalid as SpawnInput, parent));
  }
  await assert.rejects(manager.spawn(spawn, { cwd: "/tmp" }), /parent model provider/);
  await assert.rejects(manager.spawn(spawn, { cwd: "/tmp", model: parent.model }), /parent thinkingLevel/);
  await assert.rejects(manager.send(send), /Unknown subagent/);
  assert.equal(clients.length, 0);
  await manager.spawn(spawn, parent);
  for (const invalid of [{ ...send, followUp: "invalid" }, { ...send, mode: "followUp" }, { ...send, message: " " }, { ...send, action: "spawn" }]) {
    await assert.rejects(manager.send(invalid as SendInput));
  }
  assert.deepEqual(methods(clients[0]), ["start", "onEvent", "prompt"]);
});

test("send uses only prompt, preserving modes and dispositions for idle or streaming children", async () => {
  const { manager, clients } = fixture();
  await manager.spawn(spawn, parent);
  const client = clients[0];
  for (const isStreaming of [false, true]) {
    client.state.isStreaming = isStreaming;
    for (const disposition of ["started", "queued", "handled"] as const) {
      client.disposition = disposition;
      for (const followUp of [undefined, false, true]) {
        assert.deepEqual(await manager.send({ ...send, followUp }), { name: send.name, disposition });
        assert.deepEqual(client.calls.at(-1), { method: "prompt", args: [send.message, undefined, followUp ? "followUp" : "steer"] });
      }
    }
  }
  assert.ok(methods(client).every((method) => ["start", "onEvent", "prompt"].includes(method)));
  assert.equal(client.listeners.size, 1); // No settled event, waits, stop, or separate steer/followUp.
});

test("send waits for its own acceptance without serializing concurrent sends or waiting for settled", { timeout: 2000 }, async (t) => {
  const client = new FakeRpcClient();
  const { manager } = fixture(() => client);
  await manager.spawn(spawn, parent);
  const firstAck = deferred<PromptDisposition>();
  const secondAck = deferred<PromptDisposition>();
  let submissions = 0;
  const prompt = t.mock.method(client, "prompt", () => submissions++ === 0 ? firstAck.promise : secondAck.promise);
  let firstReturned = false;
  const first = manager.send(send).then((result) => { firstReturned = true; return result; });
  const second = manager.send({ ...send, followUp: true });
  assert.equal(prompt.mock.callCount(), 2);
  assert.equal(firstReturned, false);
  secondAck.resolve("queued");
  assert.deepEqual(await second, { name: send.name, disposition: "queued" });
  assert.equal(firstReturned, false);
  firstAck.resolve("started");
  assert.deepEqual(await first, { name: send.name, disposition: "started" });
});

test("send compaction and other RPC errors propagate without retry or destroying the child", async (t) => {
  const client = new FakeRpcClient();
  const { manager } = fixture(() => client);
  await manager.spawn(spawn, parent);
  for (const message of ["Cannot submit a prompt while compaction is in progress", "RPC rejected", "Agent process exited"]) {
    const error = new Error(message);
    const prompt = t.mock.method(client, "prompt", async () => { throw error; });
    await assert.rejects(manager.send(send), (actual) => actual === error);
    assert.equal(prompt.mock.callCount(), 1);
    prompt.mock.restore();
    client.disposition = "handled";
    assert.deepEqual(await manager.send(send), { name: send.name, disposition: "handled" });
  }
  await assert.rejects(manager.spawn(spawn, parent), /already exists/);
  assert.equal(client.listeners.size, 1);
  assert.ok(!methods(client).includes("stop"));
});
