import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { parseSubagentInput, resolveChildConfig } from "./config.ts";
import { createRpcAdapter } from "./rpc-client.ts";
import type {
  ParentConfigSnapshot,
  ResolvedChildConfig,
  RpcAdapter,
  RpcAdapterFactory,
  SendInput,
  SpawnInput,
  SubmissionResult,
} from "./types.ts";

/** Resources for one child, available to the event consumer before the initial prompt. */
export interface SubagentHandle {
  readonly name: string;
  readonly config: ResolvedChildConfig;
  readonly client: RpcAdapter;
}

/** Synchronous SDK boundary. Consumers must catch errors in any async work they launch. */
export type SubagentEventListener = (child: SubagentHandle, event: JsonAgentSessionEvent) => void;

interface Reservation {
  phase: "starting" | "ready" | "failed";
  child?: SubagentHandle;
  unsubscribe?: () => void;
}

export interface SubagentManagerOptions {
  // Required: events are forwarded, never silently discarded by a default no-op.
  onEvent: SubagentEventListener;
  createClient?: RpcAdapterFactory;
}

/** One instance per parent runtime; no shared names, processes, or submission queues. */
export class SubagentManager {
  private readonly records = new Map<string, Reservation>();
  private readonly onEvent: SubagentEventListener;
  private readonly createClient: RpcAdapterFactory;

  constructor(options: SubagentManagerOptions) {
    this.onEvent = options.onEvent;
    this.createClient = options.createClient ?? createRpcAdapter;
  }

  async spawn(input: SpawnInput, parent: ParentConfigSnapshot): Promise<SubmissionResult> {
    const parsed = parseSubagentInput(input);
    if (parsed.action !== "spawn") throw new Error('spawn requires action "spawn"');
    const { name, message } = parsed;
    if (this.records.has(name)) throw new Error(`Subagent ${JSON.stringify(name)} already exists`);
    // Resolve plain values synchronously: neither parent nor input is read after startup begins.
    const config = resolveChildConfig(parsed, parent);
    const record: Reservation = { phase: "starting" };
    // Reserve before even calling the factory (which may itself re-enter the manager).
    this.records.set(name, record);
    try {
      const child: SubagentHandle = { name, config, client: this.createClient(config) };
      record.child = child;
      await child.client.start(); // Adapter includes RPC readiness confirmation.
      record.unsubscribe = child.client.onEvent((event) => {
        if (this.records.get(name) === record && record.phase !== "failed") {
          this.onEvent(child, event);
        }
      });
      const disposition = await child.client.prompt(message);
      record.phase = "ready";
      return { name, disposition };
    } catch (error) {
      record.phase = "failed";
      // Keep the name reserved until cleanup finishes. Neither cleanup failure may mask
      // the original startup/submission error or prevent the other cleanup step.
      try { record.unsubscribe?.(); } catch { /* Preserve the original error. */ }
      try { await record.child?.client.stop(); } catch { /* Preserve the original error. */ }
      if (this.records.get(name) === record) this.records.delete(name);
      throw error;
    }
  }

  async send(input: SendInput): Promise<SubmissionResult> {
    const parsed = parseSubagentInput(input);
    if (parsed.action !== "send") throw new Error('send requires action "send"');
    const record = this.records.get(parsed.name);
    if (!record) throw new Error(`Unknown subagent ${JSON.stringify(parsed.name)}`);
    // "starting" includes initial prompt acceptance. Do not introduce an implicit send queue.
    if (record.phase !== "ready" || !record.child) {
      throw new Error(`Subagent ${JSON.stringify(parsed.name)} is not ready`);
    }
    const disposition = await record.child.client.prompt(parsed.message, undefined, parsed.mode);
    return { name: parsed.name, disposition };
  }
}
