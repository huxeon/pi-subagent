import type { ExtensionContext, RpcClient } from "@earendil-works/pi-coding-agent";

/** Exact, session-local key. No case folding or path encoding. */
export type SubagentName = string;
export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
export type SendMode = "steer" | "followUp";

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
  mode?: SendMode;
}

export type SubagentInput = SpawnInput | SendInput;
export type ParsedSubagentInput = SpawnInput | (SendInput & { mode: SendMode });

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

/** Official RpcClient boundary. The adapter is single-use; start includes a getState readiness check. */
export type RpcAdapter = Pick<
  RpcClient,
  "start" | "getState" | "prompt" | "onEvent" | "getLastAssistantText" | "stop"
>;
export type RpcAdapterFactory = (config: ResolvedChildConfig) => RpcAdapter;

/** Task 04/05 supplies delivery to the parent via pi.sendMessage(). */
export interface SubagentReport {
  name: SubagentName;
  text: string | null;
}
export type ReportReceiver = (report: SubagentReport) => void | Promise<void>;
