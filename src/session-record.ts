import { readFile } from "node:fs/promises";
import { buildSessionContext, CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { lstatIfPresent, normalizeAbsolutePath } from "./paths.ts";
import type { ThinkingLevel } from "./types.ts";

export interface EffectiveConfig { provider: string; model: string; thinking: ThinkingLevel; cwd: string }
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Read-only: never open through SessionManager (which may repair/rewrite a file). */
export async function readSessionRecord(file: string): Promise<EffectiveConfig> {
  const stat = await lstatIfPresent(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`No regular session file: ${file}`);
  const text = await readFile(file, "utf8");
  const values = text.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const header = values.shift();
  if (!header || header.type !== "session" || header.version !== CURRENT_SESSION_VERSION ||
      typeof header.id !== "string" || !header.id || typeof header.cwd !== "string") throw new Error("Invalid session header");
  const cwd = normalizeAbsolutePath(header.cwd);
  const ids = new Set<string>();
  for (const entry of values) {
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
        !(entry.parentId === null || typeof entry.parentId === "string" && ids.has(entry.parentId)) ||
        typeof entry.type !== "string" || typeof entry.timestamp !== "string") throw new Error("Invalid session tree");
    ids.add(entry.id);
  }
  const entries = values as unknown as SessionEntry[];
  const context = buildSessionContext(entries);
  if (!entries.some(entry => entry.type === "thinking_level_change") ||
      !context.model?.provider || !context.model.modelId || !thinkingLevels.includes(context.thinkingLevel as ThinkingLevel) ||
      !context.messages.some(message => message.role === "user" || message.role === "assistant")) {
    throw new Error("Session has no recoverable conversation/configuration");
  }
  return { cwd, provider: context.model.provider, model: context.model.modelId, thinking: context.thinkingLevel as ThinkingLevel };
}

export function sameConfig(a: EffectiveConfig, b: EffectiveConfig): boolean {
  return a.cwd === b.cwd && a.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
}
