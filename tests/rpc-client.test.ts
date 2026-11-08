import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../src/config.ts";
import { createRpcAdapterFactory, resolvePiCliPath } from "../src/rpc-client.ts";
import type { ResolvedChildConfig } from "../src/types.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

const config: ResolvedChildConfig = {
  cwd: "/unrelated/child/workspace", provider: "child-provider", model: "child-model", thinking: "high",
};

function fixture() {
  const sdk = new FakeRpcClient();
  const options: RpcClientOptions[] = [];
  const adapter = createRpcAdapterFactory((value) => { options.push(value); return sdk; })(config);
  return { sdk, adapter, options };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("CLI is the resolved SDK package's readable absolute bin, independent of cwd and argv[1]", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-path-"));
  const originalCwd = process.cwd();
  const originalArgv = process.argv[1];
  try {
    const before = resolvePiCliPath();
    process.chdir(root);
    process.argv[1] = join(root, "parent-launcher.js");
    const cli = resolvePiCliPath();
    assert.equal(cli, before);
    assert.ok(isAbsolute(cli));
    assert.ok(statSync(cli).isFile());
    assert.ok(readFileSync(cli, "utf8").length > 0);
    // Verify the loaded SDK/host metadata, not a hardcoded CLI filename or project-local package.
    const packageRoot = getPackageDir();
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(cli, realpathSync(resolve(packageRoot, manifest.bin.pi)));
    assert.notEqual(cli, process.argv[1]);
    assert.equal(fixture().options[0].cliPath, cli);
  } finally {
    process.chdir(originalCwd);
    process.argv[1] = originalArgv;
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid package roots/metadata fail before constructing any client", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-metadata-"));
  const original = process.env.PI_PACKAGE_DIR;
  let creations = 0;
  const factory = createRpcAdapterFactory(() => { creations++; return new FakeRpcClient(); });
  try {
    process.env.PI_PACKAGE_DIR = "relative-pi-package";
    assert.throws(() => factory(config), /must be absolute/);
    process.env.PI_PACKAGE_DIR = root;
    for (const manifest of [
      { name: "wrong-package", version: VERSION },
      { name: "@earendil-works/pi-coding-agent", version: "wrong-version" },
      { name: "@earendil-works/pi-coding-agent", version: VERSION },
      { name: "@earendil-works/pi-coding-agent", version: VERSION, bin: { pi: "missing-cli.js" } },
      { name: "@earendil-works/pi-coding-agent", version: VERSION, bin: { pi: "." } },
    ]) {
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      assert.throws(() => factory(config));
    }
    assert.equal(creations, 0);
  } finally {
    if (original === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("constructor options include only required overrides; all other resources retain defaults", () => {
  for (const thinking of THINKING_LEVELS) {
    const sdk = new FakeRpcClient();
    let received: RpcClientOptions | undefined;
    createRpcAdapterFactory((options) => { received = options; return sdk; })({ ...config, thinking });
    assert.deepEqual(received, {
      cliPath: resolvePiCliPath(), cwd: config.cwd, provider: config.provider, model: config.model,
      args: ["--no-session", "--thinking", thinking, "--exclude-tools", "subagent"],
    });
    assert.equal(sdk.calls.length, 0); // Construction never launches a process.
  }
});

test("start waits for getState readiness; explicit getState returns the SDK state unchanged", async (t) => {
  const { sdk, adapter } = fixture();
  const ready = deferred<typeof sdk.state>();
  const getState = t.mock.method(sdk, "getState", () => ready.promise);
  let started = false;
  const starting = adapter.start().then(() => { started = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  assert.equal(getState.mock.callCount(), 1);
  ready.resolve(sdk.state);
  await starting;
  assert.equal(await adapter.getState(), sdk.state);
  assert.equal(getState.mock.callCount(), 2);
  await adapter.stop();
  assert.deepEqual(sdk.calls.map((call) => call.method), ["start", "stop"]);
});

test("startup and handshake failures stop once and preserve the original error", async (t) => {
  for (const method of ["start", "getState"] as const) {
    await t.test(method, async (t) => {
      const { sdk, adapter } = fixture();
      const error = new Error(`${method} rejected`);
      const failing = t.mock.method(sdk, method, async () => { throw error; });
      await assert.rejects(adapter.start(), (actual) => actual === error);
      await adapter.stop();
      assert.equal(failing.mock.callCount(), 1);
      assert.equal(sdk.calls.filter((call) => call.method === "stop").length, 1);
      if (method === "start") assert.ok(!sdk.calls.some((call) => call.method === "getState"));
    });
  }
});

test("startup cleanup failure does not mask the startup error; stop still exposes cleanup failure", async (t) => {
  const { sdk, adapter } = fixture();
  const startupError = new Error("state failed");
  const stopError = new Error("cleanup failed");
  t.mock.method(sdk, "getState", async () => { throw startupError; });
  const stop = t.mock.method(sdk, "stop", async () => { throw stopError; });
  await assert.rejects(adapter.start(), (error) => error === startupError);
  await assert.rejects(adapter.stop(), (error) => error === stopError);
  assert.equal(stop.mock.callCount(), 1);
});

test("prompt delegates exact initial/send arguments, images, and all dispositions without waiting", async () => {
  const { sdk, adapter } = fixture();
  for (const disposition of ["started", "queued", "handled"] as const) {
    sdk.disposition = disposition;
    assert.equal(await adapter.prompt(" initial \n"), disposition);
    assert.deepEqual(sdk.calls.at(-1), { method: "prompt", args: [" initial \n"] });
    for (const mode of ["steer", "followUp"] as const) {
      assert.equal(await adapter.prompt(" next \n", undefined, mode), disposition);
      assert.deepEqual(sdk.calls.at(-1), { method: "prompt", args: [" next \n", undefined, mode] });
    }
  }
  const images = [{ type: "image" as const, data: "test", mimeType: "image/png" }];
  await adapter.prompt("image", images, "steer");
  assert.equal(sdk.calls.at(-1)!.args[1], images);
  assert.ok(sdk.calls.every((call) => call.method === "prompt"));
});

test("compaction and other prompt rejections propagate immediately, unchanged, with no retries", async (t) => {
  for (const message of ["Cannot prompt during compaction", "RPC rejected", "Agent process exited"]) {
    const { sdk, adapter } = fixture();
    const error = new Error(message);
    const prompt = t.mock.method(sdk, "prompt", async () => { throw error; });
    await assert.rejects(adapter.prompt("work", undefined, "followUp"), (actual) => actual === error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(prompt.mock.callCount(), 1);
    assert.equal(sdk.calls.length, 0);
  }
});

test("events subscribe/unsubscribe through the SDK; last text preserves null, empty, and full text", async () => {
  const { sdk, adapter } = fixture();
  const events: unknown[] = [];
  const listener = (event: unknown) => { events.push(event); };
  const unsubscribe = adapter.onEvent(listener);
  assert.deepEqual(sdk.calls, [{ method: "onEvent", args: [listener] }]);
  const event = { type: "agent_settled", aborted: false } as const;
  sdk.emit(event);
  assert.equal(events[0], event);
  unsubscribe();
  unsubscribe();
  sdk.emit(event);
  assert.equal(events.length, 1);
  assert.equal(sdk.listeners.size, 0);
  for (const text of [null, "", "完整结果\n"]) {
    sdk.text = text;
    assert.equal(await adapter.getLastAssistantText(), text);
    assert.deepEqual(sdk.calls.at(-1), { method: "getLastAssistantText", args: [] });
  }
});

test("Pi 1.5.0's runtime undefined text is normalized to the declared null result", async (t) => {
  const { sdk, adapter } = fixture();
  const call = t.mock.method(sdk, "getLastAssistantText", async () => undefined as unknown as null);
  assert.equal(await adapter.getLastAssistantText(), null);
  assert.equal(call.mock.callCount(), 1);
});

test("getState and getLastAssistantText errors are not hidden or retried", async (t) => {
  for (const method of ["getState", "getLastAssistantText"] as const) {
    const { sdk, adapter } = fixture();
    const error = new Error(`${method} failed`);
    const call = t.mock.method(sdk, method, async () => { throw error; });
    await assert.rejects(adapter[method](), (actual) => actual === error);
    assert.equal(call.mock.callCount(), 1);
  }
});

test("stop coalesces concurrent/repeated calls and adapters are single-use", async (t) => {
  const { sdk, adapter } = fixture();
  const done = deferred<void>();
  const stop = t.mock.method(sdk, "stop", () => done.promise);
  await adapter.start();
  await assert.rejects(adapter.start(), /already started or stopped/);
  const first = adapter.stop();
  assert.equal(adapter.stop(), first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stop.mock.callCount(), 1);
  done.resolve();
  await first;
  assert.equal(adapter.stop(), first);
  await assert.rejects(adapter.start(), /already started or stopped/);
});

test("stop before start never launches; stop during launch waits only for the launch check", async (t) => {
  const before = fixture();
  await before.adapter.stop();
  await assert.rejects(before.adapter.start(), /already started or stopped/);
  assert.deepEqual(before.sdk.calls.map((call) => call.method), ["stop"]);

  const { sdk, adapter } = fixture();
  const launched = deferred<void>();
  t.mock.method(sdk, "start", () => launched.promise);
  const starting = adapter.start();
  const rejected = assert.rejects(starting, /stopped during startup/);
  const stopping = adapter.stop();
  assert.equal(sdk.calls.length, 0);
  launched.resolve();
  await Promise.all([stopping, rejected]);
  assert.deepEqual(sdk.calls.map((call) => call.method), ["stop"]);
});

test("stop does not wait for a pending readiness RPC", async (t) => {
  const { sdk, adapter } = fixture();
  const state = deferred<typeof sdk.state>();
  t.mock.method(sdk, "getState", () => state.promise);
  const starting = adapter.start();
  const rejected = assert.rejects(starting, /stopped during startup/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await adapter.stop();
  assert.deepEqual(sdk.calls.map((call) => call.method), ["start", "stop"]);
  state.resolve(sdk.state);
  await rejected;
});
