import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SocketServer, SocketTransportError } from "./socket-transport.ts";
import type { JsonValue, RequestContext, RequestHandler, TransportOptions } from "./socket-transport.ts";
import type { WorkState } from "./types.ts";

/** Deliberately excludes abort/queue mutation and all resource-discovery APIs. */
export interface ChildPiAdapter {
  isIdle(): boolean;
  getBranch(): SessionEntry[];
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  identity?(): ChildIdentity;
}

/** Live observation only. PID/configuration are never persisted by this extension. */
export type ChildIdentity = {
  runDir: string; sessionFile: string | null; pid: number;
  cwd: string; provider: string | null; model: string | null; thinking: string;
};

export type AssistantReply = {
  text: string;
  stopReason: string;
  errorMessage?: string;
};
export type InspectResult = { state: WorkState } | { state: "idle"; reply: AssistantReply | null };
export type MessageResult = { invoked: true };

/** Raw current branch only: do not skip an empty error/aborted assistant. */
export function latestAssistantReply(entries: readonly SessionEntry[]): AssistantReply | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    return {
      text: message.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
      stopReason: message.stopReason,
      ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
    };
  }
  return null;
}

const failure = (code: string, message: string) => new SocketTransportError(code, message);
function objectParams(params: JsonValue): Record<string, JsonValue> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw failure("INVALID_PARAMS", "Expected an object");
  }
  return params;
}
function optionalBoolean(params: Record<string, JsonValue>, key: string): boolean {
  if (params[key] !== undefined && typeof params[key] !== "boolean") {
    throw failure("INVALID_PARAMS", `${key} must be a boolean`);
  }
  return params[key] === true;
}

/** Request-owned records, not a Pi message queue. Cancellation only rejects that wait. */
interface Waiter { complete(): void; cancel(error: Error): void }
export class ChildBridge {
  private state: WorkState;
  private readonly waiters = new Set<Waiter>();
  private closed = false;

  private readonly pi: ChildPiAdapter;
  constructor(pi: ChildPiAdapter) {
    this.pi = pi;
    this.state = pi.isIdle() ? "idle" : "working";
  }
  get waitingCount(): number { return this.waiters.size; }
  agentStart(): void { if (!this.closed) this.state = "working"; }
  agentSettled(): void {
    if (this.closed) return;
    if (this.readState() !== "idle") return;
    for (const waiter of [...this.waiters]) waiter.complete();
  }
  private readState(): WorkState {
    this.state = this.pi.isIdle() ? "idle" : "working";
    return this.state;
  }
  private result(): JsonValue {
    return { state: "idle", reply: latestAssistantReply(this.pi.getBranch()) };
  }
  readonly handle: RequestHandler = (method, params, { signal }: RequestContext) => {
    if (this.closed) throw failure("BRIDGE_CLOSED", "Child bridge is closed");
    if (signal.aborted) throw failure("ABORTED", "Request cancelled");
    if (method === "identity" && this.pi.identity) return this.pi.identity();
    if (method !== "message" && method !== "inspect") throw failure("METHOD_NOT_FOUND", `Unknown method: ${method}`);
    const input = objectParams(params);
    if (method === "message") {
      if (typeof input.prompt !== "string" || !input.prompt.trim()) throw failure("INVALID_PARAMS", "prompt must be a nonblank string");
      const followUp = optionalBoolean(input, "followUp");
      if (this.readState() === "idle") this.pi.sendUserMessage(input.prompt);
      else this.pi.sendUserMessage(input.prompt, { deliverAs: followUp ? "followUp" : "steer" });
      // Public Pi API returns void. No acceptance, persistence, or completion guarantee.
      return { invoked: true } satisfies MessageResult;
    }
    const wait = optionalBoolean(input, "wait");
    const state = this.readState();
    if (!wait) return { state }; // Do not even read the branch here.
    if (state === "idle") return this.result();
    return new Promise<JsonValue>((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(waiter);
        signal.removeEventListener("abort", abort);
      };
      const waiter: Waiter = {
        complete: () => {
          cleanup();
          try { resolve(this.result()); } catch (error) { reject(error); }
        },
        cancel: error => { cleanup(); reject(error); },
      };
      const abort = () => waiter.cancel(failure("ABORTED", "Inspect wait cancelled"));
      this.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  };
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.cancel(failure("BRIDGE_CLOSED", "Child bridge closed"));
  }
}

/** One runtime owns one server. No socket is opened until session_start. */
export function registerChildBridge(pi: ExtensionAPI, runDir: string, options: TransportOptions = {}): void {
  let bridge: ChildBridge | undefined;
  let server: Promise<SocketServer> | undefined;
  let stopping: Promise<void> | undefined;
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (server || stopping) return;
    bridge = new ChildBridge({
      isIdle: () => ctx.isIdle(),
      getBranch: () => ctx.sessionManager.getBranch(),
      sendUserMessage: (content, delivery) => pi.sendUserMessage(content, delivery),
      identity: () => ({ runDir, sessionFile: ctx.sessionManager.getSessionFile() ?? null, pid: process.pid,
        cwd: ctx.cwd, provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null, thinking: pi.getThinkingLevel() }),
    });
    server = SocketServer.listen(runDir, bridge.handle, options);
    try { await server; }
    catch (error) { bridge.close(); throw error; }
  });
  pi.on("agent_start", () => { bridge?.agentStart(); });
  pi.on("agent_settled", () => { bridge?.agentSettled(); });
  pi.on("session_shutdown", () => {
    if (stopping) return stopping;
    bridge?.close();
    // Also covers shutdown while async listen is still starting; never unlink a failed bind.
    stopping = (async () => {
      const listening = await server?.catch(() => undefined);
      await listening?.close();
      bridge = undefined;
    })();
    return stopping;
  });
}
