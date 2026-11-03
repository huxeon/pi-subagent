import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/socket-protocol.ts";
import type { Frame, JsonValue } from "../src/socket-protocol.ts";
import { prepareSocketAddress } from "../src/socket-path.ts";
import { SocketClient, SocketServer, SocketTransportError } from "../src/socket-transport.ts";
import type { RequestHandler } from "../src/socket-transport.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-sock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xdgRuntimeDir = join(root, "xdg");
  await mkdir(xdgRuntimeDir, { mode: 0o700 });
  const runDir = join(root, "run");
  const options = { address: { xdgRuntimeDir }, connectTimeoutMs: 1000 };
  const { socketPath } = await prepareSocketAddress(runDir, options.address);
  const listen = async (handler: RequestHandler) => {
    const server = await SocketServer.listen(runDir, handler, options);
    t.after(() => server.close());
    return server;
  };
  const connect = async () => {
    const client = await SocketClient.connect(runDir, options);
    t.after(() => client.close());
    return client;
  };
  return { root, runDir, options, socketPath, listen, connect };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) assert.fail("Condition did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as NodeJS.ErrnoException).code, expected);
  return true;
};
async function raw(path: string): Promise<Socket> {
  const socket = createConnection(path);
  await once(socket, "connect");
  return socket;
}

test("framing: split UTF-8, multiple frames, strict JSON/shape/bytes, bounded incomplete input", () => {
  const frames: Frame[] = [
    { type: "request", id: 1, method: "inspect", params: "中文😀" },
    { type: "cancel", id: 1 },
    { type: "response", id: 1, ok: false, error: { code: "X", message: "bad" } },
  ];
  const bytes = Buffer.concat(frames.map(f => encodeFrame(f)));
  const decoder = new FrameDecoder();
  const received: Frame[] = [];
  for (const byte of bytes) decoder.push(Buffer.from([byte]), frame => received.push(frame));
  assert.deepEqual(received, frames);
  const batch: Frame[] = [];
  new FrameDecoder().push(bytes, frame => batch.push(frame));
  assert.deepEqual(batch, frames);
  for (const invalid of ["\n", "nope\n", "[]\n", '{"type":"cancel","id":0}\n', '{"type":"request","id":1,"method":"x"}\n', '{"type":"response","id":1,"ok":true}\n']) {
    assert.throws(() => new FrameDecoder().push(Buffer.from(invalid), () => {}), code("PROTOCOL_ERROR"));
  }
  assert.throws(() => new FrameDecoder().push(Buffer.from([0xff, 10]), () => {}), code("PROTOCOL_ERROR"));
  const small = new FrameDecoder(10);
  small.push(Buffer.alloc(10, 32), () => {});
  assert.throws(() => small.push(Buffer.from("x"), () => {}), code("FRAME_TOO_LARGE"));
  const f: Frame = { type: "response", id: 1, ok: true, result: "中" };
  const length = encodeFrame(f).length - 1;
  assert.equal(encodeFrame(f, length).length, length + 1);
  assert.throws(() => encodeFrame(f, length - 1), code("FRAME_TOO_LARGE"));
});

test("immediate/delayed/error responses run concurrently, do not block short UI queries", async t => {
  const f = await fixture(t);
  const gate = deferred<JsonValue>();
  const server = await f.listen((method, params) => {
    if (method === "wait") return gate.promise;
    if (method === "throw") throw new Error("handler failed");
    if (method === "reject") return Promise.reject(new SocketTransportError("NOT_READY", "not ready"));
    return params;
  });
  const client = await f.connect();
  const wait = client.request("wait");
  assert.deepEqual(await client.request("status", { state: "working" }), { state: "working" });
  assert.equal(server.pendingCount, 1);
  assert.equal(client.pendingCount, 1);
  await assert.rejects(client.request("throw"), code("HANDLER_ERROR"));
  await assert.rejects(client.request("reject"), code("NOT_READY"));
  const queries = Array.from({ length: 30 }, (_, i) => client.request("echo", i));
  assert.deepEqual(await Promise.all(queries), Array.from({ length: 30 }, (_, i) => i));
  gate.resolve({ state: "idle" });
  assert.deepEqual(await wait, { state: "idle" });
  assert.equal(server.pendingCount, 0);
  assert.equal(client.pendingCount, 0);
});

test("AbortSignal, timeout, pre-abort: cleanup waiting handlers, no late responses or retained listeners", async t => {
  const f = await fixture(t);
  const waits = new Map<number, ReturnType<typeof deferred<JsonValue>>>();
  let aborted = 0;
  let calls = 0;
  const server = await f.listen((method, _params, { id, signal }) => {
    calls++;
    if (method === "status") return "working";
    const gate = deferred<JsonValue>();
    waits.set(id, gate);
    signal.addEventListener("abort", () => { aborted++; waits.delete(id); gate.resolve("too late"); }, { once: true });
    return gate.promise;
  });
  const client = await f.connect();
  const already = new AbortController();
  already.abort();
  await assert.rejects(client.request("wait", null, { signal: already.signal }), code("ABORTED"));
  assert.equal(calls, 0);
  const controller = new AbortController();
  const waiting = client.request("wait", null, { signal: controller.signal, timeoutMs: 1000 });
  const rejected = assert.rejects(waiting, code("ABORTED"));
  await until(() => waits.size === 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await rejected;
  await until(() => aborted === 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(client.request("wait", null, { timeoutMs: 20 }), code("TIMEOUT"));
  await until(() => aborted === 2);
  assert.equal(waits.size, 0);
  assert.equal(server.pendingCount, 0);
  assert.equal(client.pendingCount, 0);
  assert.equal(await client.request("status"), "working");
  const done = new AbortController();
  await client.request("status", null, { signal: done.signal });
  assert.equal(getEventListeners(done.signal, "abort").length, 0);
  done.abort(); // Does not cancel an already-completed request.
});

test("cancel/completion/timeout races settle once; late rejection is handled", async t => {
  const f = await fixture(t);
  let gate = deferred<JsonValue>();
  const server = await f.listen(() => gate.promise);
  const client = await f.connect();
  for (let i = 0; i < 30; i++) {
    gate = deferred<JsonValue>();
    const current = gate;
    const abort = new AbortController();
    const request = client.request("wait", null, { signal: abort.signal, timeoutMs: 50 });
    const result = request.then(() => "done", (e: SocketTransportError) => e.code);
    await until(() => server.pendingCount === 1);
    if (i % 2) { current.resolve("done"); abort.abort(); }
    else { abort.abort(); current.reject(new Error("late rejection")); }
    assert.ok(["done", "ABORTED"].includes(await result));
    await until(() => server.pendingCount === 0);
    assert.equal(client.pendingCount, 0);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  }
  // Completion around the timeout boundary may win or lose, but must settle once.
  for (let i = 0; i < 12; i++) {
    gate = deferred<JsonValue>();
    const current = gate;
    const controller = new AbortController();
    const result = client.request("wait", null, { timeoutMs: 10, signal: controller.signal })
      .then(() => "done", (e: SocketTransportError) => e.code);
    const timer = setTimeout(() => current.resolve("done"), i % 2 ? 5 : 15);
    assert.ok(["done", "TIMEOUT"].includes(await result));
    clearTimeout(timer);
    current.resolve("late");
    await until(() => server.pendingCount === 0);
    assert.equal(client.pendingCount, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("disconnect cleans only that connection; server close aborts all, rejects clients and unlinks owned socket", async t => {
  const f = await fixture(t);
  const active = new Set<AbortSignal>();
  let reenterClose = false;
  const server = await f.listen((_method, _params, { signal }) => {
    active.add(signal);
    signal.addEventListener("abort", () => {
      active.delete(signal);
      if (reenterClose) void server.close();
    }, { once: true });
    return new Promise<JsonValue>(() => {});
  });
  const a = await f.connect();
  const b = await f.connect();
  const aw = assert.rejects(a.request("wait"), code("CONNECTION_CLOSED"));
  const bw = assert.rejects(b.request("wait"), code("CONNECTION_CLOSED"));
  await until(() => server.pendingCount === 2);
  await a.close();
  await aw;
  await until(() => server.pendingCount === 1);
  assert.equal(active.size, 1);
  assert.equal(b.pendingCount, 1);
  reenterClose = true;
  await Promise.all([server.close(), server.close()]);
  await bw;
  assert.equal(active.size, 0);
  assert.equal(server.pendingCount, 0);
  assert.equal(server.connectionCount, 0);
  assert.equal(b.pendingCount, 0);
  await assert.rejects(lstat(f.socketPath), code("ENOENT"));
});

test("wire cancellation has no ack; duplicate cancel/late completion cannot respond twice; fragmented concurrent frames", async t => {
  const f = await fixture(t);
  const gate = deferred<JsonValue>();
  let aborted = 0;
  const server = await f.listen((method, params, { signal }) => {
    if (method !== "wait") return params;
    signal.addEventListener("abort", () => aborted++, { once: true });
    return gate.promise;
  });
  const socket = await raw(f.socketPath);
  t.after(() => socket.destroy());
  const frames: Frame[] = [];
  const decoder = new FrameDecoder();
  socket.on("data", chunk => decoder.push(chunk, frame => frames.push(frame)));
  const req = encodeFrame({ type: "request", id: 1, method: "wait", params: "中文" });
  for (const byte of req) socket.write(Buffer.from([byte]));
  await until(() => server.pendingCount === 1);
  socket.write(Buffer.concat([
    encodeFrame({ type: "cancel", id: 1 }), encodeFrame({ type: "cancel", id: 1 }),
    encodeFrame({ type: "request", id: 2, method: "echo", params: "now" }),
  ]));
  await until(() => frames.length === 1);
  gate.resolve("late");
  socket.write(encodeFrame({ type: "request", id: 3, method: "echo", params: "barrier" }));
  await until(() => frames.length === 2);
  assert.deepEqual(frames.map(frame => frame.id), [2, 3]);
  assert.equal(aborted, 1);
  assert.equal(server.pendingCount, 0);
});

test("invalid/oversize/wrong-direction/reused-id frames disconnect peer and cancel its requests", async t => {
  const f = await fixture(t);
  let aborted = 0;
  const server = await f.listen((_method, _params, { signal }) => {
    signal.addEventListener("abort", () => aborted++, { once: true });
    return new Promise<JsonValue>(() => {});
  });
  const invalid = [Buffer.from("bad\n"), Buffer.alloc(MAX_FRAME_BYTES + 1, 32),
    encodeFrame({ type: "response", id: 1, ok: true, result: null }),
    encodeFrame({ type: "request", id: 1, method: "duplicate", params: null })];
  for (const [i, bytes] of invalid.entries()) {
    const socket = await raw(f.socketPath);
    socket.on("error", () => {});
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    socket.write(encodeFrame({ type: "request", id: 1, method: "wait", params: null }));
    await until(() => server.pendingCount === 1);
    socket.write(bytes);
    socket.resume();
    await closed;
    await until(() => server.pendingCount === 0);
    assert.equal(aborted, i + 1);
  }
});

test("oversize/non-serializable handler results are request errors, connection remains usable", async t => {
  const f = await fixture(t);
  await f.listen(method => {
    if (method === "big") return "x".repeat(MAX_FRAME_BYTES);
    if (method === "cycle") { const value: { self?: JsonValue } = {}; value.self = value; return value; }
    return null;
  });
  const client = await f.connect();
  await assert.rejects(client.request("big"), code("RESPONSE_ERROR"));
  await assert.rejects(client.request("cycle"), code("RESPONSE_ERROR"));
  await assert.rejects(client.request("x", "x".repeat(MAX_FRAME_BYTES)), code("FRAME_TOO_LARGE"));
  assert.equal(await client.request("ok"), null);
  assert.equal(client.pendingCount, 0);
});

test("non-reading peers cannot accumulate an unbounded response queue", async t => {
  const f = await fixture(t);
  let calls = 0;
  const server = await f.listen(() => { calls++; return "x".repeat(MAX_FRAME_BYTES - 1000); });
  const socket = await raw(f.socketPath);
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  // Do not read the responses. Each individual result fits, their queued sum does not.
  socket.write(Buffer.concat(Array.from({ length: 12 }, (_, i) =>
    encodeFrame({ type: "request", id: i + 1, method: "large", params: null }))));
  await until(() => calls > 0 && server.connectionCount === 0);
  assert.equal(server.pendingCount, 0);
  // A different connection remains usable after the stalled one was discarded.
  const client = await f.connect();
  assert.equal((await client.request("large") as string).length, MAX_FRAME_BYTES - 1000);
});

test("live sockets are never replaced; ordinary files and symlinks are untouched", async t => {
  const f = await fixture(t);
  await f.listen(() => "alive");
  const before = await lstat(f.socketPath);
  await assert.rejects(SocketServer.listen(f.runDir, () => null, f.options), code("SOCKET_IN_USE"));
  assert.equal((await lstat(f.socketPath)).ino, before.ino);
  const client = await f.connect();
  assert.equal(await client.request("status"), "alive");
  const other = join(f.root, "other-run");
  const { socketPath } = await prepareSocketAddress(other, f.options.address);
  await writeFile(socketPath, "preserve");
  await assert.rejects(SocketServer.listen(other, () => null, f.options), code("UNSAFE_SOCKET"));
  assert.equal(await readFile(socketPath, "utf8"), "preserve");
  await rm(socketPath);
  await symlink(f.socketPath, socketPath);
  await assert.rejects(SocketServer.listen(other, () => null, f.options), code("UNSAFE_SOCKET"));
  assert.ok((await lstat(socketPath)).isSymbolicLink());
});

test("confirmed stale socket is reclaimed; refused/missing/pre-aborted connections fail cleanly", async t => {
  const f = await fixture(t);
  await assert.rejects(f.connect(), code("ENOENT"));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(SocketClient.connect(f.runDir, { ...f.options, signal: aborted.signal }), code("ABORTED"));
  // Isolated fake Node listener exits without server.close, leaving its own stale endpoint.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import net from "node:net"; net.createServer().listen(process.argv[1], () => process.exit(0));', f.socketPath], { timeout: 5000 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok((await lstat(f.socketPath)).isSocket());
  await assert.rejects(f.connect(), code("ECONNREFUSED"));
  await f.listen(() => "reclaimed");
  const client = await f.connect();
  assert.equal(await client.request("status"), "reclaimed");
});

test("client rejects protocol errors/disconnect, clears timeout and AbortSignal listener", async t => {
  const f = await fixture(t);
  const server = createServer(socket => {
    socket.once("data", () => socket.end('{"type":"cancel","id":1}\n'));
  });
  await new Promise<void>(resolve => server.listen(f.socketPath, resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = await f.connect();
  const controller = new AbortController();
  await assert.rejects(client.request("wait", null, { signal: controller.signal }), code("PROTOCOL_ERROR"));
  await client.close();
  assert.equal(client.pendingCount, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
