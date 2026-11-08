import type {
  ParentConfigSnapshot,
  ParsedSubagentInput,
  ResolvedChildConfig,
  SpawnInput,
  ThinkingLevel,
} from "./types.ts";

export const SUBAGENT_TOOL_NAME = "subagent";
export const THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const satisfies readonly ThinkingLevel[];

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function thinkingLevel(value: unknown, field: string): ThinkingLevel {
  if (typeof value !== "string" || !THINKING_LEVELS.some((level) => level === value)) {
    throw new Error(`${field} must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevel;
}

/** Validate raw arguments; preserve names/messages and default only send.followUp. */
export function parseSubagentInput(value: unknown): ParsedSubagentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("subagent arguments must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.action !== "spawn" && input.action !== "send") {
    throw new Error('action must be "spawn" or "send"');
  }
  const name = nonEmptyString(input.name, "name");
  const message = nonEmptyString(input.message, "message");
  if (input.action === "send") {
    if (input.mode !== undefined) throw new Error("mode is no longer supported; use followUp instead");
    const followUp = input.followUp === undefined ? false : input.followUp;
    if (typeof followUp !== "boolean") throw new Error("followUp must be a boolean");
    return { action: "send", name, message, followUp };
  }

  if ((input.provider === undefined) !== (input.model === undefined)) {
    throw new Error("provider and model must be provided together or both omitted");
  }
  const result: SpawnInput = { action: "spawn", name, message };
  if (input.provider !== undefined) {
    result.provider = nonEmptyString(input.provider, "provider");
    result.model = nonEmptyString(input.model, "model");
  }
  if (input.thinking !== undefined) {
    result.thinking = thinkingLevel(input.thinking, "thinking");
  }
  return result;
}

/** Resolve once at spawn time. No model lookup, capability clamping, or I/O. */
export function resolveChildConfig(
  input: SpawnInput,
  parent: ParentConfigSnapshot,
): ResolvedChildConfig {
  const parsed = parseSubagentInput(input);
  if (parsed.action !== "spawn") {
    throw new Error('resolveChildConfig requires action "spawn"');
  }
  const provider = parsed.provider === undefined
    ? nonEmptyString(parent.model?.provider, "parent model provider")
    : parsed.provider;
  const model = parsed.model === undefined
    ? nonEmptyString(parent.model?.id, "parent model id")
    : parsed.model;
  const thinking = parsed.thinking === undefined
    ? thinkingLevel(parent.thinkingLevel, "parent thinkingLevel")
    : parsed.thinking;
  return { cwd: nonEmptyString(parent.cwd, "parent cwd"), provider, model, thinking };
}
