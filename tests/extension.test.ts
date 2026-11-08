import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import type {
  ExtensionAPI, ExtensionContext, ExtensionHandler, ExtensionToolContext,
  MessageRenderer, SessionShutdownEvent, SessionStartEvent, Theme, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { STATUS_WIDGET_KEY } from "../src/ui.ts";
import { renderSubagentReport, subagentToolRenderers } from "../src/render.ts";
import { THINKING_LEVELS } from "../src/config.ts";
import { SubagentManager } from "../src/manager.ts";
import type { subagentParameters } from "../src/tools.ts";
import type { ParentMessageSender } from "../src/report.ts";
import type { ParentConfigSnapshot, PromptDisposition, ResolvedChildConfig } from "../src/types.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

const spawn = { action: "spawn", name: " 审查员 / Reviewer ", message: " initial task\n " } as const;
const send = { action: "send", name: spawn.name, message: " next task\n " } as const;
const settled = { type: "agent_settled", aborted: false } as const;
const parent: ParentConfigSnapshot = {
  cwd: "/parent", model: { provider: "parent-p", id: "parent-m" }, thinkingLevel: "medium",
};
const toolContext = (snapshot: ParentConfigSnapshot = parent) => snapshot as ExtensionToolContext;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Only production APIs; unexpected registration/API access fails. */
function fakeAPI() {
  const tools: ToolDefinition[] = [];
  const renderers = new Map<string, MessageRenderer>();
  const shutdowns: ExtensionHandler<SessionShutdownEvent>[] = [];
  const starts: ExtensionHandler<SessionStartEvent>[] = [];
  const deliveries: Parameters<ParentMessageSender>[] = [];
  const api = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerMessageRenderer(type: string, renderer: MessageRenderer) { renderers.set(type, renderer); },
    on(event: string, handler: ExtensionHandler<SessionShutdownEvent> | ExtensionHandler<SessionStartEvent>) {
      if (event === "session_shutdown") shutdowns.push(handler as ExtensionHandler<SessionShutdownEvent>);
      else {
        assert.equal(event, "session_start");
        starts.push(handler as ExtensionHandler<SessionStartEvent>);
      }
      return () => {};
    },
    sendMessage(...args: Parameters<ParentMessageSender>) {
      assert.equal(this, pi, "sendMessage must remain bound to this extension API");
      deliveries.push(args);
    },
  };
  const pi = new Proxy(api, { get(target, key, receiver) {
    assert.ok(key in target, `Unexpected ExtensionAPI access: ${String(key)}`);
    return Reflect.get(target, key, receiver);
  } }) as unknown as ExtensionAPI;
  return {
    pi, tools, renderers, shutdowns, starts, deliveries,
    async start(ctx: ExtensionContext) {
      for (const handler of starts) await handler({ type: "session_start", reason: "startup" }, ctx);
    },
    call(input: unknown, ctx = toolContext()) {
      assert.equal(tools.length, 1);
      return tools[0].execute("tool-call", input, undefined, undefined, ctx);
    },
    async shutdown(reason: SessionShutdownEvent["reason"] = "quit") {
      for (const handler of shutdowns) await handler({ type: "session_shutdown", reason }, {} as ExtensionContext);
    },
  };
}

function fixture() {
  const host = fakeAPI();
  const clients: FakeRpcClient[] = [];
  const configs: ResolvedChildConfig[] = [];
  extension(host.pi, { createClient(config) {
    configs.push(config);
    const client = new FakeRpcClient();
    clients.push(client);
    return client;
  } });
  return { ...host, clients, configs };
}

test("production entry connects event-driven status widget and clears it for every shutdown reason", async (t) => {
  for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
    const host = fixture();
    t.after(() => host.shutdown(reason));
    type Factory = Exclude<Parameters<ExtensionContext["ui"]["setWidget"]>[1], undefined>;
    const widgets: (Factory | undefined)[] = [];
    const ctx = { mode: "tui", ui: { setWidget(key: string, content: Factory | undefined) {
      assert.equal(key, STATUS_WIDGET_KEY);
      widgets.push(content);
    } } } as unknown as ExtensionContext;
    await host.start(ctx);
    assert.equal(widgets.length, 1);
    assert.equal(widgets.at(-1), undefined);
    await host.call(spawn);
    const theme = { fg: (_token: string, text: string) => text } as Theme;
    const rendered = () => widgets.at(-1)!({} as TUI, theme).render(120).join("\n");
    assert.match(rendered(), /idle/);
    const child = host.clients[0];
    const stale = [...child.listeners][0];
    child.emit({ type: "agent_start" });
    assert.match(rendered(), /working/);
    await host.call(send);
    assert.match(rendered(), /working/);
    assert.equal(host.deliveries.length, 0, "status updates do not create model messages");
    const text = deferred<string | null>();
    t.mock.method(child, "getLastAssistantText", () => text.promise);
    child.emit(settled);
    assert.match(rendered(), /idle/, "UI must update before result read finishes");
    assert.equal(host.deliveries.length, 0);
    assert.equal(child.calls.some((c) => c.method === "getState"), false);
    await host.shutdown(reason);
    assert.equal(widgets.at(-1), undefined);
    const count = widgets.length;
    stale({ type: "agent_start" });
    stale(settled);
    text.resolve("late result");
    await nextTurn();
    assert.equal(widgets.length, count);
    assert.equal(host.deliveries.length, 0);
  }
});

test("production status UI is not accessed in RPC, JSON or print sessions", async (t) => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const host = fixture();
    t.after(() => host.shutdown());
    await host.start({ mode, get ui() { throw new Error("non-TUI UI access"); } } as unknown as ExtensionContext);
    await host.call(spawn);
    host.clients[0].emit({ type: "agent_start" });
    host.clients[0].emit(settled);
    await nextTurn();
    assert.equal(host.deliveries.length, 1, "normal reports still work outside TUI");
    await host.shutdown();
  }
});

test("root factory registers one direct subagent tool, object schema and asynchronous guidance", () => {
  const host = fixture();
  assert.equal(host.clients.length, 0);
  assert.equal(host.shutdowns.length, 1);
  const [tool] = host.tools;
  assert.equal(host.tools.length, 1);
  assert.equal(tool.name, "subagent"); // Exact match for --exclude-tools subagent.
  assert.equal(tool.exposure ?? "direct", "direct");
  assert.equal(tool.defaultActive ?? true, true);
  const schema = tool.parameters as typeof subagentParameters;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["action", "name", "message"]);
  assert.deepEqual(Object.keys(schema.properties!), ["action", "name", "message", "provider", "model", "thinking", "followUp"]);
  assert.deepEqual(schema.properties!.action.enum, ["spawn", "send"]);
  assert.deepEqual(schema.properties!.thinking.enum, THINKING_LEVELS);
  assert.equal(schema.properties!.followUp.type, "boolean");
  assert.equal(schema.properties!.followUp.default, false);
  for (const key of ["name", "message", "provider", "model"] as const) {
    assert.equal(schema.properties![key].type, "string");
    assert.equal(schema.properties![key].minLength, 1);
    const pattern = new RegExp(schema.properties![key].pattern as string);
    assert.equal(pattern.test(" \n\t"), false);
    assert.equal(pattern.test(" 原样 "), true);
  }
  assert.match(tool.description, /NOT task completion/);
  assert.match(tool.description, /asynchronously/);
  assert.match(tool.description, /stay alive.*more messages/);
  assert.match(tool.description, /handled may produce no report/);
  assert.match(tool.description, /provider\/model.*together/);
  assert.equal(tool.renderCall, subagentToolRenderers.renderCall);
  assert.equal(tool.renderResult, subagentToolRenderers.renderResult);
  assert.equal(host.renderers.get("subagent.report"), renderSubagentReport);
});

test("factory, including the production default, starts no clients, processes, timers or watchers", (t) => {
  const fail = () => { throw new Error("Background resource started from factory"); };
  const guards = [
    t.mock.method(childProcess, "spawn", fail), t.mock.method(childProcess, "fork", fail),
    t.mock.method(childProcess, "exec", fail), t.mock.method(childProcess, "execFile", fail),
    t.mock.method(fs, "watch", fail), t.mock.method(fs, "watchFile", fail),
    t.mock.method(globalThis, "setTimeout", fail), t.mock.method(globalThis, "setInterval", fail),
    t.mock.method(globalThis, "setImmediate", fail),
  ];
  try {
    extension(fakeAPI().pi);
    extension(fakeAPI().pi, { createClient: fail });
    for (const guard of guards) assert.equal(guard.mock.callCount(), 0);
  } finally {
    for (const guard of guards) guard.mock.restore();
  }
});

test("tool delegates parsed spawn/send inputs, defaults and invocation-time parent snapshot to its manager", async (t) => {
  const host = fakeAPI();
  const spawnCalls: unknown[][] = [];
  const sendCalls: unknown[][] = [];
  t.mock.method(SubagentManager.prototype, "spawn", async (...args: Parameters<SubagentManager["spawn"]>) => {
    spawnCalls.push(args);
    return { name: args[0].name, disposition: "started" as const };
  });
  t.mock.method(SubagentManager.prototype, "send", async (...args: Parameters<SubagentManager["send"]>) => {
    sendCalls.push(args);
    return { name: args[0].name, disposition: "queued" as const };
  });
  extension(host.pi);
  const current = { cwd: "/first", model: { provider: "first-p", id: "first-m" }, thinkingLevel: "low" as "low" | "high" };
  const first = await host.call({ ...spawn, thinking: "max" }, toolContext(current));
  assert.deepEqual(spawnCalls[0], [{ ...spawn, thinking: "max" }, current]);
  const captured = spawnCalls[0][1] as ParentConfigSnapshot;
  assert.notEqual(captured, current);
  assert.notEqual(captured.model, current.model);
  current.cwd = "/second";
  current.model.provider = "second-p";
  current.model.id = "second-m";
  current.thinkingLevel = "high";
  await host.call({ ...spawn, provider: "explicit-p", model: "explicit-m" }, toolContext(current));
  assert.deepEqual(spawnCalls[1], [{ ...spawn, provider: "explicit-p", model: "explicit-m" }, current]);
  assert.deepEqual(captured, { cwd: "/first", model: { provider: "first-p", id: "first-m" }, thinkingLevel: "low" });
  const unusedContext = new Proxy({} as ExtensionToolContext, { get() { throw new Error("send must not read parent config"); } });
  await host.call(send, unusedContext);
  await host.call({ ...send, followUp: true }, unusedContext);
  assert.deepEqual(sendCalls, [[{ ...send, followUp: false }], [{ ...send, followUp: true }]]);
  assert.deepEqual(first, { content: [{ type: "text", text: JSON.stringify({ name: spawn.name, disposition: "started" }) }],
    details: { name: spawn.name, disposition: "started", config: { provider: "first-p", model: "first-m", thinking: "max" } } });
  await host.shutdown();
});

test("production manager receives fresh cwd/model/thinking and accepts thinking alone or independent inheritance", async (t) => {
  const host = fixture();
  t.after(() => host.shutdown());
  let i = 0;
  for (const pair of [undefined, { provider: "explicit-p", model: "explicit-m" }]) {
    for (const thinking of [undefined, "max"] as const) {
      const snapshot = { ...parent, cwd: `/call-${i}` };
      const reply = await host.call({ ...spawn, name: String(i++), ...pair, ...(thinking ? { thinking } : {}) }, toolContext(snapshot));
      const expected = { provider: pair?.provider ?? "parent-p", model: pair?.model ?? "parent-m", thinking: thinking ?? "medium" };
      assert.deepEqual(host.configs.at(-1), { cwd: snapshot.cwd, ...expected });
      assert.deepEqual(reply.details, { name: String(i - 1), disposition: "started", config: expected });
    }
  }
  await host.call({ ...spawn, provider: "p", model: "m", thinking: "off" }, toolContext({ cwd: "/explicit" }));
  assert.deepEqual(host.configs.at(-1), { cwd: "/explicit", provider: "p", model: "m", thinking: "off" });
  await host.call(send, toolContext({ cwd: "/not-the-child-cwd" }));
  assert.equal(host.configs.length, 5); // send never creates/reconfigures the child.
  assert.deepEqual(host.clients.at(-1)!.calls.at(-1), { method: "prompt", args: [send.message, undefined, "steer"] });
});

test("spawn presentation config is fixed before awaiting acceptance, not read from a later parent context", async (t) => {
  const host = fixture();
  t.after(() => host.shutdown());
  const entered = deferred<void>();
  const ack = deferred<PromptDisposition>();
  t.mock.method(FakeRpcClient.prototype, "prompt", () => { entered.resolve(); return ack.promise; });
  const current = { cwd: "/first", model: { provider: "original-p", id: "original-m" }, thinkingLevel: "low" as "low" | "high" };
  const pending = host.call(spawn, toolContext(current));
  await entered.promise;
  current.model.provider = "later-p";
  current.model.id = "later-m";
  current.thinkingLevel = "high";
  ack.resolve("started");
  const result = await pending;
  assert.deepEqual(result.details, { name: spawn.name, disposition: "started",
    config: { provider: "original-p", model: "original-m", thinking: "low" } });
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ name: spawn.name, disposition: "started" }) }]);
  assert.equal(host.clients[0].calls.some((call) => call.method === "getState"), false);
});

test("partial provider/model, invalid inputs, missing inherited configuration and RPC failures throw tool errors", async (t) => {
  const host = fixture();
  t.after(() => host.shutdown());
  for (const partial of [{ provider: "p" }, { model: "m" }]) {
    await assert.rejects(host.call({ ...spawn, ...partial }), /provided together/);
  }
  for (const invalid of [{ ...spawn, name: " " }, { ...spawn, message: "" }, { ...spawn, thinking: "unknown" },
    { ...send, followUp: "unknown" }, { ...send, mode: "followUp" }, { ...spawn, action: "stop" }]) {
    await assert.rejects(host.call(invalid));
  }
  await assert.rejects(host.call(spawn, toolContext({ cwd: "/missing" })), /parent model provider/);
  await assert.rejects(host.call(spawn, toolContext({ cwd: "/missing", model: parent.model })), /parent thinkingLevel/);
  await assert.rejects(host.call(send), /Unknown subagent/);
  assert.equal(host.clients.length, 0);
  await host.call(spawn);
  await assert.rejects(host.call(spawn), /already exists/);
  const error = new Error("Cannot submit a prompt while compaction is in progress");
  const prompt = t.mock.method(host.clients[0], "prompt", async () => { throw error; });
  await assert.rejects(host.call(send), (actual) => actual === error);
  assert.equal(prompt.mock.callCount(), 1);
});

test("spawn/send return each RPC acceptance without waiting for settled or fetching results", { timeout: 2000 }, async (t) => {
  for (const disposition of ["started", "queued", "handled"] as const) {
    const host = fakeAPI();
    const client = new FakeRpcClient();
    extension(host.pi, { createClient: () => client });
    t.after(() => host.shutdown());
    const entered = deferred<void>();
    const spawnAck = deferred<PromptDisposition>();
    const sendAck = deferred<PromptDisposition>();
    let submissions = 0;
    const prompt = t.mock.method(client, "prompt", () => {
      entered.resolve();
      return submissions++ === 0 ? spawnAck.promise : sendAck.promise;
    });
    let returned = false;
    const spawning = host.call(spawn).then((result) => { returned = true; return result; });
    await entered.promise;
    assert.equal(returned, false);
    assert.deepEqual(prompt.mock.calls[0].arguments, [spawn.message]);
    spawnAck.resolve(disposition);
    assert.deepEqual((await spawning).details, { name: spawn.name, disposition,
      config: { provider: "parent-p", model: "parent-m", thinking: "medium" } });
    let sent = false;
    const sending = host.call(send).then((result) => { sent = true; return result; });
    assert.equal(sent, false);
    assert.deepEqual(prompt.mock.calls[1].arguments, [send.message, undefined, "steer"]);
    sendAck.resolve(disposition);
    assert.deepEqual((await sending).details, { name: spawn.name, disposition });
    assert.equal(prompt.mock.callCount(), 2);
    assert.equal(client.listeners.size, 1);
    assert.equal(host.deliveries.length, 0);
    assert.ok(!client.calls.some(({ method }) => method === "getLastAssistantText"));
    await host.shutdown();
  }
});

test("production pi.sendMessage binding uses exact report content and steer/triggerTurn options", async (t) => {
  const host = fixture();
  t.after(() => host.shutdown());
  await host.call(spawn);
  await host.call({ ...send, followUp: true });
  const client = host.clients[0];
  for (const text of [" full result\n第二行 ", null]) {
    client.text = text;
    client.emit(settled);
    await nextTurn();
    assert.deepEqual(host.deliveries.at(-1), [{
      customType: "subagent.report", display: true,
      content: `Subagent: ${spawn.name}\n\n${text ?? "(No assistant text available.)"}`,
      details: { name: spawn.name, text },
    }, { deliverAs: "steer", triggerTurn: true }]);
  }
  assert.equal(client.listeners.size, 1);
  assert.equal(host.deliveries.length, 2);
});

for (const reason of ["quit", "reload", "new", "resume", "fork"] satisfies SessionShutdownEvent["reason"][]) {
  test(`session_shutdown ${reason} awaits cleanup, rejects new work and prevents stale reports`, { timeout: 2000 }, async (t) => {
    const host = fixture();
    t.after(() => host.shutdown(reason));
    await host.call(spawn);
    const client = host.clients[0];
    const text = deferred<string | null>();
    t.mock.method(client, "getLastAssistantText", () => text.promise);
    const stopEntered = deferred<void>();
    const stopped = deferred<void>();
    const stop = t.mock.method(client, "stop", () => { stopEntered.resolve(); return stopped.promise; });
    const stale = [...client.listeners][0];
    client.emit(settled);
    let closed = false;
    const shutdown = host.shutdown(reason).then(() => { closed = true; });
    await stopEntered.promise;
    assert.equal(closed, false);
    assert.equal(client.listeners.size, 0);
    await assert.rejects(host.call(send), /closed/);
    await assert.rejects(host.call({ ...spawn, name: "new" }), /closed/);
    stopped.resolve();
    await shutdown;
    const replacement = fixture();
    t.after(() => replacement.shutdown());
    await assert.rejects(replacement.call(send), /Unknown subagent/);
    await replacement.call(spawn); // Same name is available in a fresh extension instance.
    text.resolve("late old result");
    stale(settled);
    await nextTurn();
    assert.equal(host.deliveries.length, 0);
    assert.equal(replacement.deliveries.length, 0);
    replacement.clients[0].text = "new runtime result";
    replacement.clients[0].emit(settled);
    await nextTurn();
    assert.equal(replacement.deliveries.length, 1);
    await host.shutdown(reason);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(host.clients.length, 1);
  });
}
