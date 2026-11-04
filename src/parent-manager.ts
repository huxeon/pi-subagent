import { rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { createSubagentDirectory, getSubagentPaths, lstatIfPresent, normalizeAbsolutePath, scanSubagents, type SubagentPaths } from "./paths.ts";
import { SocketClient, SocketTransportError, cleanupStaleSocket, type JsonValue, type RequestOptions, type TransportOptions } from "./socket-transport.ts";
import type { ChildIdentity, InspectResult, MessageResult } from "./child-bridge.ts";
import type { Availability, SubagentOperation } from "./types.ts";
import { readSessionRecord, sameConfig, thinkingLevels, type EffectiveConfig } from "./session-record.ts";
import type { ProcessDriver } from "./process-driver.ts";

export type SpawnInput = Extract<SubagentOperation, { operation: "spawn" }>;
export interface BridgeClient { request(method: string, params: JsonValue, options?: RequestOptions): Promise<JsonValue>; close(): Promise<void> }
export interface ManagerOptions {
  agentDir: string; parentSessionId: string; driver: ProcessDriver;
  transport?: TransportOptions;
  connect?: (runDir: string, signal?: AbortSignal) => Promise<BridgeClient>;
  readyTimeoutMs?: number; persistenceTimeoutMs?: number; pollMs?: number;
}
export interface RecoveryResult { name: string; connected: boolean; error?: string }
const failure = (code: string, message: string) => new SocketTransportError(code, message);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const retryable = (error: unknown) => ["ENOENT", "ECONNREFUSED", "CONNECTION_CLOSED"].includes((error as { code?: string }).code ?? "");

export function resolveSpawnConfig(input: SpawnInput, parent: EffectiveConfig): EffectiveConfig {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("prompt must be nonblank");
  const config = { provider: input.provider ?? parent.provider, model: input.model ?? parent.model,
    thinking: input.thinking ?? parent.thinking, cwd: normalizeAbsolutePath(input.cwd ?? parent.cwd, parent.cwd) };
  if (!config.provider?.trim() || !config.model?.trim() || config.provider.includes("\0") || config.model.includes("\0") ||
      !thinkingLevels.includes(config.thinking)) throw new Error("Invalid creation configuration");
  return config;
}

/** Session-scoped service. No UI, Pi context, refresh timer, or persistent management state. */
export class ParentManager {
  readonly options: ManagerOptions;
  private readonly clients = new Map<string, BridgeClient>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(options: ManagerOptions) {
    this.options = { ...options, agentDir: normalizeAbsolutePath(options.agentDir) };
    for (const value of [options.readyTimeoutMs ?? 30_000, options.persistenceTimeoutMs ?? 30_000, options.pollMs ?? 50]) {
      if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new RangeError("Invalid manager timeout");
    }
  }
  private paths(name: string) { return getSubagentPaths(this.options.agentDir, this.options.parentSessionId, name); }
  private signal(signal?: AbortSignal) { return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal; }
  private check(signal?: AbortSignal) { if (signal?.aborted) throw failure("ABORTED", "Operation cancelled"); }
  private mutate<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(name) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => { this.check(this.lifetime.signal); return work(); });
    this.mutations.set(name, task);
    void task.finally(() => { if (this.mutations.get(name) === task) this.mutations.delete(name); }).catch(() => {});
    return task;
  }
  private async assertDirectory(paths: SubagentPaths): Promise<boolean> {
    // Revalidate all managed ancestors immediately before destructive work.
    for (const path of [paths.subagentsDir, paths.parentDir, paths.runDir]) {
      const info = await lstatIfPresent(path);
      if (!info) return false;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${path}`);
    }
    return true;
  }
  private async connect(paths: SubagentPaths, signal?: AbortSignal): Promise<BridgeClient> {
    this.check(signal);
    const client = await (this.options.connect ? this.options.connect(paths.runDir, signal) : SocketClient.connect(paths.runDir, { ...this.options.transport, signal }));
    try {
      const identity = await client.request("identity", {}, { timeoutMs: 1000, signal }) as ChildIdentity;
      if (identity.runDir !== paths.runDir || identity.sessionFile !== paths.sessionFile ||
          !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.cwd !== "string") {
        throw failure("IDENTITY_MISMATCH", "Bridge belongs to a different session");
      }
      return client;
    } catch (error) { await client.close(); throw error; }
  }
  private async ready(paths: SubagentPaths, signal: AbortSignal): Promise<BridgeClient> {
    const timeout = AbortSignal.timeout(this.options.readyTimeoutMs ?? 30_000);
    const bounded = AbortSignal.any([signal, timeout]);
    try {
      while (true) {
        this.check(bounded);
        try { return await this.connect(paths, bounded); }
        catch (error) { if (!retryable(error)) throw error; }
        await delay(this.options.pollMs ?? 50, undefined, { signal: bounded });
      }
    } catch (error) {
      this.check(signal);
      if (timeout.aborted) throw failure("READY_TIMEOUT", "Child bridge readiness timed out");
      throw error;
    }
  }
  private async client(name: string, signal: AbortSignal): Promise<BridgeClient> {
    this.check(this.lifetime.signal);
    const existing = this.clients.get(name);
    if (existing) return existing;
    const paths = this.paths(name);
    if (!await this.assertDirectory(paths)) throw new Error(`Unknown subagent: ${name}`);
    // Each in-progress connection owns its caller's cancellation. Do not let one
    // caller abort another caller's connection attempt through a shared Promise.
    const connected = await this.connect(paths, signal);
    if (signal.aborted) { await connected.close(); this.check(signal); }
    const raced = this.clients.get(name);
    if (raced) { await connected.close(); return raced; }
    this.clients.set(name, connected);
    return connected;
  }
  private async closeClient(name: string) {
    const client = this.clients.get(name);
    this.clients.delete(name);
    await client?.close();
  }
  private async request(name: string, method: string, params: JsonValue, options: RequestOptions): Promise<JsonValue> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError("Invalid request timeoutMs");
    const owner = this.signal(options.signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([owner, timeout]);
    this.check(owner);
    try {
      const client = await this.client(name, signal);
      return await client.request(method, params, { timeoutMs, signal });
    } catch (error) {
      // Deadline includes connection establishment, not just the wire request.
      this.check(owner);
      if (timeout.aborted) throw failure("TIMEOUT", "Request timed out");
      // Never automatically retry a message: acknowledgement means invocation only.
      if (!["ABORTED", "TIMEOUT"].includes((error as { code?: string }).code ?? "")) await this.closeClient(name);
      throw error;
    }
  }
  async spawn(input: SpawnInput, parent: EffectiveConfig, options: RequestOptions = {}): Promise<{ name: string; config: EffectiveConfig; invoked: true }> {
    const paths = this.paths(input.name); // Validate name before any work.
    const config = resolveSpawnConfig(input, parent); // Snapshot at invocation, not after queued work.
    const signal = this.signal(options.signal);
    return this.mutate(input.name, async () => {
      this.check(signal);
      if (!(await stat(config.cwd)).isDirectory()) throw new Error("cwd is not a directory");
      // EEXIST never enters cleanup: this task owns only a successful exclusive mkdir.
      await createSubagentDirectory(this.options.agentDir, this.options.parentSessionId, input.name);
      let launched = false;
      try {
        if (await this.options.driver.isRunning(paths)) throw new Error("Existing child process for new directory");
        await cleanupStaleSocket(paths.runDir, this.options.transport);
        this.check(signal);
        await this.options.driver.start(paths, config);
        launched = true;
        const client = await this.ready(paths, signal);
        this.clients.set(input.name, client);
        const live = await client.request("identity", {}, { timeoutMs: 1000, signal }) as ChildIdentity;
        // Pi legitimately clamps thinking to the selected model's capabilities. Report
        // that effective level; do not silently accept a fallback provider/model/cwd.
        if (live.cwd !== config.cwd || live.provider !== config.provider || live.model !== config.model ||
            !thinkingLevels.includes(live.thinking as EffectiveConfig["thinking"])) throw new Error("Pi effective configuration differs from creation configuration");
        const effective = { ...config, thinking: live.thinking as EffectiveConfig["thinking"] };
        await client.request("message", { prompt: input.prompt, followUp: false }, { ...options, signal });
        const deadline = Date.now() + (this.options.persistenceTimeoutMs ?? 30_000);
        while (true) {
          this.check(signal);
          let saved: EffectiveConfig | undefined;
          try { saved = await readSessionRecord(paths.sessionFile); } catch (error) {
            if ((error as NodeJS.ErrnoException).code && !["ENOENT"].includes((error as NodeJS.ErrnoException).code!)) throw error;
          }
          if (saved) {
            if (!sameConfig(effective, saved)) throw new Error("Persisted initial configuration differs from effective configuration");
            return { name: input.name, config: effective, invoked: true };
          }
          if (Date.now() >= deadline) throw failure("PERSISTENCE_TIMEOUT", "No recoverable initial session was persisted");
          await delay(this.options.pollMs ?? 50, undefined, { signal }).catch(() => this.check(signal));
        }
      } catch (error) {
        await this.closeClient(input.name);
        try {
          if (launched) await this.options.driver.stop(paths);
          else if (await this.options.driver.isRunning(paths)) throw new Error("Unowned live process retained");
          await cleanupStaleSocket(paths.runDir, this.options.transport);
          if (await this.assertDirectory(paths)) await rm(paths.runDir, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `Spawn failed: ${errorText(error)}; cleanup incomplete: ${errorText(cleanupError)}`);
        }
        throw error;
      }
    });
  }
  // Intentionally retain wire message/inspect so a reloaded parent can reconnect to still-running old child bridges.
  async send(name: string, prompt: string, followUp = false, options: RequestOptions = {}): Promise<MessageResult> {
    return await this.request(name, "message", { prompt, followUp }, options) as MessageResult;
  }
  async status(name: string, options: RequestOptions = {}): Promise<InspectResult> {
    return await this.request(name, "inspect", { wait: false }, { ...options, timeoutMs: options.timeoutMs ?? 1000 }) as InspectResult;
  }
  async wait(name: string, options: RequestOptions = {}): Promise<InspectResult> {
    return await this.request(name, "inspect", { wait: true }, { ...options, timeoutMs: options.timeoutMs ?? 1_800_000 }) as InspectResult;
  }
  async list(options: RequestOptions = {}): Promise<Array<{ name: string; status: Availability }>> {
    const paths = await scanSubagents(this.options.agentDir, this.options.parentSessionId);
    return Promise.all(paths.map(async ({ name }) => {
      try { const result = await this.status(name, options); return { name, status: { available: true, workState: result.state } as Availability }; }
      catch (error) { return { name, status: { available: false, reason: "connection-error", error: { message: errorText(error) } } as Availability }; }
    }));
  }
  async recover(): Promise<RecoveryResult[]> {
    const paths = await scanSubagents(this.options.agentDir, this.options.parentSessionId);
    return Promise.all(paths.map(path => this.mutate(path.name, async () => {
      try {
        let client: BridgeClient | undefined;
        try { client = await this.connect(path, this.lifetime.signal); }
        catch (error) {
          if (!retryable(error)) throw error;
          if (await this.options.driver.isRunning(path)) {
            // Still starting, reloading or orphaned: wait, but never launch a duplicate.
            client = await this.ready(path, this.lifetime.signal);
          } else {
            const saved = await readSessionRecord(path.sessionFile);
            if (!(await stat(saved.cwd)).isDirectory()) throw new Error("Saved cwd is unavailable");
            await cleanupStaleSocket(path.runDir, this.options.transport);
            await this.options.driver.start(path); // No configuration overrides, no old prompt.
            try {
              client = await this.ready(path, this.lifetime.signal);
              const identity = await client.request("identity", {}, { timeoutMs: 1000, signal: this.lifetime.signal }) as ChildIdentity;
              if (!sameConfig(saved, identity as EffectiveConfig)) { await client.close(); throw new Error("Restored configuration mismatch (possible model fallback)"); }
            } catch (startError) {
              await client?.close();
              try { await this.options.driver.stop(path); }
              catch (stopError) { throw new AggregateError([startError, stopError], `Recovery failed: ${errorText(startError)}; cleanup incomplete: ${errorText(stopError)}`); }
              throw startError;
            }
          }
        }
        if (this.lifetime.signal.aborted) { await client.close(); this.check(this.lifetime.signal); }
        await this.closeClient(path.name);
        this.clients.set(path.name, client);
        return { name: path.name, connected: true };
      } catch (error) { return { name: path.name, connected: false, error: errorText(error) }; }
    }).catch(error => ({ name: path.name, connected: false, error: errorText(error) }))));
  }
  async stop(name: string, options: RequestOptions = {}): Promise<void> {
    const paths = this.paths(name);
    const signal = this.signal(options.signal);
    this.check(signal);
    return this.mutate(name, async () => {
      this.check(signal);
      await this.closeClient(name);
      if (!await this.assertDirectory(paths)) return; // Idempotent, including stopped children.
      this.check(signal);
      // A graceful stop already initiated must finish safely; cancellation never
      // abandons process cleanup or claims the operation was rolled back.
      await this.options.driver.stop(paths);
      this.check(signal);
      await cleanupStaleSocket(paths.runDir, this.options.transport);
      this.check(signal);
      if (await this.assertDirectory(paths)) {
        this.check(signal);
        await rm(paths.runDir, { recursive: true, force: true });
      }
    });
  }
  shutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.closing = (async () => {
      await Promise.all([...this.clients.keys()].map(name => this.closeClient(name)));
      await Promise.allSettled([...this.mutations.values()]);
      await Promise.all([...this.clients.keys()].map(name => this.closeClient(name)));
      if (reason === "reload") return;
      const paths = await scanSubagents(this.options.agentDir, this.options.parentSessionId);
      const results = await Promise.allSettled(paths.map(async path => {
        await this.options.driver.stop(path);
        await cleanupStaleSocket(path.runDir, this.options.transport);
      }));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Some subagents could not be stopped; records retained");
    })();
    return this.closing;
  }
}
