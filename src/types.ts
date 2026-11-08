import type { ExtensionContext, RpcClient } from "@earendil-works/pi-coding-agent";

/** Exact, session-local key. No case folding or path encoding. */
export type SubagentName = string;
export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

export interface SpawnInput {
  action: "spawn";
  name: SubagentName;
  message: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface SendInput {
  action: "send";
  name: SubagentName;
  message: string;
  followUp?: boolean;
}

export type SubagentInput = SpawnInput | SendInput;
export type ParsedSubagentInput = SpawnInput | (SendInput & { followUp: boolean });

/** Plain values captured at tool invocation, not a retained extension context. */
export interface ParentConfigSnapshot {
  readonly cwd: string;
  readonly model?: {
    readonly provider?: string;
    readonly id?: string;
  };
  readonly thinkingLevel?: ThinkingLevel;
}

export interface ResolvedChildConfig {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

export type PromptDisposition = Awaited<ReturnType<RpcClient["prompt"]>>;
export interface SubmissionResult {
  name: SubagentName;
  disposition: PromptDisposition;
}

/** Presentation metadata; the model-facing JSON remains SubmissionResult. */
export interface SubmissionDetails extends SubmissionResult {
  config?: Pick<ResolvedChildConfig, "provider" | "model" | "thinking">;
}

/** Live activity, not submission acceptance or task success. */
export interface SubagentStatus {
  readonly name: SubagentName;
  readonly state: "running" | "idle";
}
export type StatusReceiver = (statuses: readonly SubagentStatus[]) => void;

/**
 * Official RpcClient boundary. Single-use; start includes a getState readiness check.
 * stop must be idempotent and bounded even during readiness/requests (as in rpc-client.ts).
 */
export type RpcAdapter = Pick<
  RpcClient,
  "start" | "getState" | "prompt" | "onEvent" | "getLastAssistantText" | "stop"
>;
export type RpcAdapterFactory = (config: ResolvedChildConfig) => RpcAdapter;

/** Settled-only result; report.ts formats delivery to the parent via pi.sendMessage(). */
export interface SubagentReport {
  name: SubagentName;
  text: string | null;
}
export type ReportReceiver = (report: SubagentReport) => void | Promise<void>;
