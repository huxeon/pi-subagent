import { lstat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket, Server } from "node:net";
import { prepareSocketAddress } from "./socket-path.ts";
import type { SocketAddressOptions } from "./socket-path.ts";
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES, SocketTransportError } from "./socket-protocol.ts";
import type { Frame, JsonValue, RequestFrame, ResponseFrame } from "./socket-protocol.ts";

export { SocketTransportError } from "./socket-protocol.ts";
export type { JsonValue } from "./socket-protocol.ts";

export interface RequestOptions { timeoutMs?: number; signal?: AbortSignal }
export interface TransportOptions {
  address?: SocketAddressOptions;
  /** Connection establishment / stale-socket probe only; not the inspect wait timeout. */
  connectTimeoutMs?: number;
}
export interface RequestContext { id: number; signal: AbortSignal }
/** Must release request-owned wait records/listeners synchronously on signal abort.
 * Returning/rejecting settles normally; a late settlement after abort is ignored.
 * Never use this signal to abort the child Pi itself.
 */
export type RequestHandler = (method: string, params: JsonValue, context: RequestContext) => JsonValue | Promise<JsonValue>;

const failure = (code: string, message: string) => new SocketTransportError(code, message);
function duration(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new RangeError("timeoutMs must be a positive 32-bit integer");
  return value;
}

/** No application-level output queue: a stalled peer is disconnected at a bounded high-water mark. */
function send(socket: Socket, frame: Frame): void {
  const bytes = encodeFrame(frame);
  if (socket.destroyed || !socket.writable) throw failure("CONNECTION_CLOSED", "Socket is closed");
  if (socket.writableLength + bytes.length > MAX_FRAME_BYTES * 2) throw failure("BACKPRESSURE", "Socket peer is not reading");
  socket.write(bytes);
}

function openSocket(path: string, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  duration(timeoutMs);
  if (signal?.aborted) return Promise.reject(failure("ABORTED", "Connection cancelled"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(failure("TIMEOUT", "Socket connection timed out")), timeoutMs);
    const abort = () => finish(failure("ABORTED", "Connection cancelled"));
    const onError = (error: Error) => finish(error);
    const onConnect = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      if (error) { socket.destroy(); reject(error); }
      else resolve(socket);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Only ECONNREFUSED proves staleness. Permission errors/timeouts are not permission to unlink.
 * The private runtime directory is the trust boundary; inode checks detect observed replacements,
 * but this is not an atomic lock against a malicious same-UID process racing unlink/bind.
 */
async function removeStaleSocket(path: string, timeoutMs: number): Promise<void> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!before) return;
  if (!before.isSocket() || before.isSymbolicLink() || before.uid !== process.getuid?.()) {
    throw failure("UNSAFE_SOCKET", `Refusing to remove non-owned socket or other file: ${path}`);
  }
  try {
    const probe = await openSocket(path, timeoutMs);
    probe.destroy();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code !== "ECONNREFUSED") throw error;
    const after = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (!after) return;
    if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) {
      throw failure("UNSAFE_SOCKET", "Socket changed during stale check");
    }
    // Probe again after stat: do not remove an endpoint that has become connectable.
    try { const probe = await openSocket(path, timeoutMs); probe.destroy(); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      if ((e as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw e;
      const current = await lstat(path);
      if (current.dev !== before.dev || current.ino !== before.ino) throw failure("UNSAFE_SOCKET", "Socket changed during stale check");
      await unlink(path);
      return;
    }
  }
  throw failure("SOCKET_IN_USE", `Socket already has a listener: ${path}`);
}

/** Parent cleanup uses exactly the listener's ownership/probe/inode checks. Never removes a live endpoint. */
export async function cleanupStaleSocket(runDir: string, options: TransportOptions = {}): Promise<void> {
  const { socketPath } = await prepareSocketAddress(runDir, options.address);
  await removeStaleSocket(socketPath, options.connectTimeoutMs ?? 5000);
}

export class SocketClient {
  readonly socketPath: string;
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private nextId = 0;
  private ended = false;
  private readonly pending = new Map<number, { finish: (error?: Error, result?: JsonValue) => void }>();
  private readonly closed: Promise<void>;

  private constructor(socketPath: string, socket: Socket) {
    this.socketPath = socketPath;
    this.socket = socket;
    this.closed = new Promise(resolve => socket.once("close", resolve));
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.once("close", () => { this.stop(failure("CONNECTION_CLOSED", "Socket disconnected")); this.detach(); });
  }
  static async connect(runDir: string, options: TransportOptions & { signal?: AbortSignal } = {}): Promise<SocketClient> {
    const { socketPath } = await prepareSocketAddress(runDir, options.address);
    return new SocketClient(socketPath, await openSocket(socketPath, options.connectTimeoutMs ?? 5000, options.signal));
  }
  get pendingCount(): number { return this.pending.size; }
  request(method: string, params: JsonValue = null, options: RequestOptions = {}): Promise<JsonValue> {
    const timeoutMs = duration(options.timeoutMs ?? 30_000);
    if (this.ended) return Promise.reject(failure("CONNECTION_CLOSED", "Socket is closed"));
    if (options.signal?.aborted) return Promise.reject(failure("ABORTED", "Request cancelled"));
    if (this.nextId === Number.MAX_SAFE_INTEGER) return Promise.reject(failure("ID_EXHAUSTED", "Reconnect to allocate request numbers"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: JsonValue) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      const cancel = (code: string, message: string) => {
        if (!this.pending.has(id)) return;
        finish(failure(code, message));
        try { send(this.socket, { type: "cancel", id }); }
        catch (error) { this.stop(error as Error); }
      };
      const abort = () => cancel("ABORTED", "Request cancelled");
      const timer = setTimeout(() => cancel("TIMEOUT", "Request timed out"), timeoutMs);
      this.pending.set(id, { finish });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { send(this.socket, { type: "request", id, method, params }); }
      catch (error) {
        finish(error as Error);
        if ((error as SocketTransportError).code === "BACKPRESSURE" || this.socket.destroyed) this.stop(error as Error);
      }
    });
  }
  async close(): Promise<void> {
    this.stop(failure("CONNECTION_CLOSED", "Client closed"));
    await this.closed;
  }
  private onData = (chunk: Buffer): void => {
    try {
      this.decoder.push(chunk, frame => {
        if (this.ended) return;
        if (frame.type !== "response") throw failure("PROTOCOL_ERROR", "Client expected a response");
        if (frame.id > this.nextId) throw failure("PROTOCOL_ERROR", "Unknown response number");
        // A response already in transit when cancelled is harmless. No tombstone table is needed.
        this.pending.get(frame.id)?.finish(frame.ok ? undefined : failure(frame.error.code, frame.error.message), frame.ok ? frame.result : undefined);
      });
    } catch (error) { this.stop(error as Error); }
  };
  private onError = (error: Error): void => { this.stop(error); };
  private onEnd = (): void => { this.stop(failure("CONNECTION_CLOSED", "Socket disconnected")); };
  private stop(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) request.finish(error);
    this.decoder.clear();
    this.socket.destroy();
  }
  private detach(): void {
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("error", this.onError);
    this.socket.removeListener("end", this.onEnd);
  }
}

interface Peer { socket: Socket; pending: Map<number, AbortController>; dispose: () => void }
export class SocketServer {
  readonly socketPath: string;
  private readonly server: Server;
  private readonly peers = new Set<Peer>();
  private closing?: Promise<void>;
  private stopping = false;
  private constructor(socketPath: string, handler: RequestHandler) {
    this.socketPath = socketPath;
    this.server = createServer(socket => this.accept(socket, handler));
    // Startup uses its own rejecting listener; after startup errors tear down owned resources.
    this.server.on("error", () => { if (this.server.listening) void this.close(); });
  }
  static async listen(runDir: string, handler: RequestHandler, options: TransportOptions = {}): Promise<SocketServer> {
    const timeoutMs = duration(options.connectTimeoutMs ?? 5000);
    const { socketPath } = await prepareSocketAddress(runDir, options.address);
    await removeStaleSocket(socketPath, timeoutMs);
    const instance = new SocketServer(socketPath, handler);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { instance.server.removeListener("listening", onListening); reject(error); };
      const onListening = () => { instance.server.removeListener("error", onError); resolve(); };
      instance.server.once("error", onError);
      instance.server.once("listening", onListening);
      instance.server.listen(socketPath);
    });
    return instance;
  }
  get connectionCount(): number { return this.peers.size; }
  get pendingCount(): number { return [...this.peers].reduce((sum, peer) => sum + peer.pending.size, 0); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    // Publish before aborting handlers: their cleanup may call close() reentrantly.
    this.closing = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    for (const peer of this.peers) peer.dispose();
    // Node owns and unlinks its bound Unix socket on server.close. Never unlink on failed listen.
    this.server.close(error => error ? reject(error) : resolve());
    return this.closing;
  }
  private accept(socket: Socket, handler: RequestHandler): void {
    if (this.stopping) { socket.destroy(); return; }
    const decoder = new FrameDecoder();
    let lastId = 0;
    let disposed = false;
    const pending = new Map<number, AbortController>();
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.peers.delete(peer);
      const requests = [...pending.values()];
      pending.clear();
      for (const controller of requests) controller.abort(failure("CONNECTION_CLOSED", "Request connection closed"));
      decoder.clear();
      socket.destroy();
    };
    const finish = (request: RequestFrame, frame: ResponseFrame) => {
      if (!pending.delete(request.id)) return; // Cancel/disconnect already won.
      try { send(socket, frame); }
      catch (error) {
        if (["BACKPRESSURE", "CONNECTION_CLOSED"].includes((error as SocketTransportError).code)) { dispose(); return; }
        // A bad/oversize handler result is an error for this request, not an unhandled rejection.
        try { send(socket, { type: "response", id: request.id, ok: false, error: { code: "RESPONSE_ERROR", message: (error as Error).message } }); }
        catch { dispose(); }
      }
    };
    const receive = (frame: Frame) => {
      if (disposed) return;
      if (frame.type === "cancel") {
        const controller = pending.get(frame.id);
        pending.delete(frame.id);
        controller?.abort(failure("CANCELLED", "Remote request cancelled"));
        return; // No cancel acknowledgement or second response.
      }
      if (frame.type !== "request" || frame.id <= lastId) throw failure("PROTOCOL_ERROR", "Expected strictly increasing request numbers");
      lastId = frame.id;
      const controller = new AbortController();
      pending.set(frame.id, controller);
      // Invoke concurrently, attach rejection handler immediately, and never await a long handler here.
      let result: JsonValue | Promise<JsonValue>;
      try { result = handler(frame.method, frame.params, { id: frame.id, signal: controller.signal }); }
      catch (error) { result = Promise.reject(error); }
      void Promise.resolve(result).then(
        value => finish(frame, { type: "response", id: frame.id, ok: true, result: value }),
        error => finish(frame, { type: "response", id: frame.id, ok: false, error: {
          code: error instanceof SocketTransportError ? error.code : "HANDLER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        } }),
      );
    };
    const onData = (chunk: Buffer) => { try { decoder.push(chunk, receive); } catch { dispose(); } };
    const peer: Peer = { socket, pending, dispose };
    this.peers.add(peer);
    socket.on("data", onData);
    socket.on("end", dispose);
    socket.on("error", dispose);
    socket.once("close", () => {
      dispose();
      socket.removeListener("data", onData);
      socket.removeListener("end", dispose);
      socket.removeListener("error", dispose);
    });
  }
}
