import type { ExtensionContext, RpcClient } from "@earendil-works/pi-coding-agent";

/** Exact, session-local key. No case folding or path encoding. */
export type SubagentName = string;
export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

/** Model overrides are atomic: inherit both fields or supply both. */
export type ModelSelection =
  | { readonly provider: string; readonly model: string }
  | { readonly provider?: never; readonly model?: never };

export type SpawnInput = {
  readonly action: "spawn";
  readonly name: SubagentName;
  readonly message: string;
  readonly thinking?: ThinkingLevel;
  readonly followUp?: never;
} & ModelSelection;

export interface SendInput {
  readonly action: "send";
  readonly name: SubagentName;
  readonly message: string;
  readonly followUp?: boolean;
  readonly provider?: never;
  readonly model?: never;
  readonly thinking?: never;
}

export type SubagentInput = SpawnInput | SendInput;
export type ParsedSendInput = SendInput & { readonly followUp: boolean };
export type ParsedSubagentInput = SpawnInput | ParsedSendInput;

/** Plain values captured at tool invocation, not a retained extension context.
 * Explicit undefined represents an unavailable SDK context value, just like omission.
 */
export interface ParentConfigSnapshot {
  readonly cwd: string;
  readonly model?: {
    readonly provider?: string;
    readonly id?: string;
  } | undefined;
  readonly thinkingLevel?: ThinkingLevel | undefined;
}

export interface ResolvedChildConfig {
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

export type PromptDisposition = Awaited<ReturnType<RpcClient["prompt"]>>;
export interface SubmissionResult {
  readonly name: SubagentName;
  readonly disposition: PromptDisposition;
}

/** Presentation metadata; the model-facing JSON remains SubmissionResult. */
export interface SubmissionDetails extends SubmissionResult {
  readonly config?: Pick<ResolvedChildConfig, "provider" | "model" | "thinking">;
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
  readonly name: SubagentName;
  readonly text: string | null;
}
export type ReportReceiver = (report: SubagentReport) => void | Promise<void>;
