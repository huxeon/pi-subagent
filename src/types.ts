import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** Internal inputs only; not a tool schema or socket protocol. */
export type SubagentOperation =
  | { operation: "create"; name: string; prompt: string; provider?: string; model?: string; thinking?: ThinkingLevel; cwd?: string }
  | { operation: "message"; name: string; prompt: string; followUp?: boolean }
  | { operation: "inspect"; name?: string; wait?: boolean; timeout?: number }
  | { operation: "destroy"; name: string };

export type WorkState = "working" | "idle";

/** Parent-side observation; never persisted and never inferred from files. */
export type Availability =
  | { available: true; workState: WorkState }
  | { available: false; reason: "starting" | "stopped" | "unavailable" }
  | { available: false; reason: "connection-error"; error: { message: string; code?: string } };
