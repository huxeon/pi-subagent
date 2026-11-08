import { parseSubagentInput, resolveChildConfig } from "./config.ts";
import { createRpcAdapter } from "./rpc-client.ts";
import { createReportReceiver } from "./report.ts";
import type { ParentMessageSender } from "./report.ts";
import type {
  ParentConfigSnapshot,
  ReportReceiver,
  ResolvedChildConfig,
  RpcAdapter,
  RpcAdapterFactory,
  SendInput,
  SpawnInput,
  SubmissionResult,
} from "./types.ts";

/** Resources are captured before awaiting startup, so shutdown can stop starting children. */
interface SubagentHandle {
  readonly name: string;
  readonly config: ResolvedChildConfig;
  readonly client: RpcAdapter;
}

interface Reservation {
  phase: "starting" | "ready" | "failed";
  child?: SubagentHandle;
  unsubscribe?: () => void;
  cleanup?: Promise<void>;
}

export interface SubagentManagerOptions {
  // Required; task 05 binds this to the current extension instance's pi.sendMessage.
  sendMessage: ParentMessageSender;
  createClient?: RpcAdapterFactory;
}

/** One instance per parent runtime; no shared names, processes, or submission queues. */
export class SubagentManager {
  private readonly records = new Map<string, Reservation>();
  private readonly receiveReport: ReportReceiver;
  private closed = false;
  private stopping?: Promise<void>;
  private readonly createClient: RpcAdapterFactory;

  constructor(options: SubagentManagerOptions) {
    this.receiveReport = createReportReceiver(options.sendMessage);
    this.createClient = options.createClient ?? createRpcAdapter;
  }

  async spawn(input: SpawnInput, parent: ParentConfigSnapshot): Promise<SubmissionResult> {
    this.assertOpen();
    const parsed = parseSubagentInput(input);
    if (parsed.action !== "spawn") throw new Error('spawn requires action "spawn"');
    const { name, message } = parsed;
    if (this.records.has(name)) throw new Error(`Subagent ${JSON.stringify(name)} already exists`);
    // Resolve plain values synchronously: neither parent nor input is read after startup begins.
    const config = resolveChildConfig(parsed, parent);
    this.assertOpen(); // Also guard reentrant configuration getters.
    const record: Reservation = { phase: "starting" };
    // Reserve before even calling the factory (which may itself re-enter the manager).
    this.records.set(name, record);
    try {
      const child: SubagentHandle = { name, config, client: this.createClient(config) };
      record.child = child;
      this.assertCurrent(name, record); // A synchronous factory may have called shutdown.
      await child.client.start(); // Adapter includes RPC readiness confirmation.
      this.assertCurrent(name, record);
      record.unsubscribe = child.client.onEvent((event) => {
        if (event.type === "agent_settled" && this.isCurrent(name, record)) {
          // SDK invokes listeners synchronously and never awaits their return value.
          void this.reportSettled(child, record);
        }
      });
      this.assertCurrent(name, record);
      const disposition = await child.client.prompt(message);
      this.assertCurrent(name, record);
      record.phase = "ready";
      return { name, disposition };
    } catch (error) {
      // Share cleanup with shutdown, preserving the original error and the reservation
      // until cleanup finishes. Late startup/prompt completion cannot revive the record.
      await this.cleanup(record);
      if (this.records.get(name) === record) this.records.delete(name);
      throw error;
    }
  }

  async send(input: SendInput): Promise<SubmissionResult> {
    this.assertOpen();
    const parsed = parseSubagentInput(input);
    if (parsed.action !== "send") throw new Error('send requires action "send"');
    this.assertOpen();
    const record = this.records.get(parsed.name);
    if (!record) throw new Error(`Unknown subagent ${JSON.stringify(parsed.name)}`);
    // "starting" includes initial prompt acceptance. Do not introduce an implicit send queue.
    if (record.phase !== "ready" || !record.child) {
      throw new Error(`Subagent ${JSON.stringify(parsed.name)} is not ready`);
    }
    const disposition = await record.child.client.prompt(parsed.message, undefined, parsed.mode);
    this.assertCurrent(parsed.name, record);
    return { name: parsed.name, disposition };
  }

  /** Terminal, idempotent runtime teardown. Never waits for outstanding RPC requests/reports. */
  shutdown(): Promise<void> {
    this.closed = true; // Synchronous: block requests and delivery even before cleanup starts.
    return this.stopping ??= Promise.resolve().then(async () => {
      try {
        await Promise.all([...this.records.values()].map((record) => this.cleanup(record)));
      } finally {
        this.records.clear(); // Includes reservations whose factory/start/prompt failed or is pending.
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Subagent manager is closed");
  }

  private isCurrent(name: string, record: Reservation): boolean {
    return !this.closed && this.records.get(name) === record && record.phase !== "failed";
  }

  private assertCurrent(name: string, record: Reservation): void {
    this.assertOpen();
    if (!this.isCurrent(name, record)) throw new Error(`Subagent ${JSON.stringify(name)} is no longer active`);
  }

  private async reportSettled(child: SubagentHandle, record: Reservation): Promise<void> {
    try {
      // Start the read at the event boundary, not after a submission count or a previous report.
      const text = await child.client.getLastAssistantText();
      if (!this.isCurrent(child.name, record)) return;
      await this.receiveReport({ name: child.name, text });
    } catch {
      // Best effort only. SDK cannot catch async listener failures; no retry, crash report,
      // process removal, or recovery is triggered by a read/delivery failure.
    }
  }

  private cleanup(record: Reservation): Promise<void> {
    record.phase = "failed";
    // Defer one microtask so reentrant factory/onEvent calls finish assigning resources.
    return record.cleanup ??= Promise.resolve().then(async () => {
      const unsubscribe = record.unsubscribe;
      record.unsubscribe = undefined;
      try { unsubscribe?.(); } catch { /* Still attempt stop and release the name. */ }
      // Production adapter coalesces stop and uses the SDK's bounded SIGTERM/SIGKILL stop.
      // In particular, do not await start/getState or an outstanding initial prompt here.
      try { await record.child?.client.stop(); } catch { /* Isolate each child's cleanup failure. */ }
      record.child = undefined;
    });
  }
}
