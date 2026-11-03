import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAgentDir } from "./agent-dir.ts";
import { ParentManager, type ManagerOptions, type RecoveryResult } from "./parent-manager.ts";
import { TmuxProcessDriver } from "./process-driver.ts";
import type { EffectiveConfig } from "./session-record.ts";

export function parentConfig(pi: ExtensionAPI, ctx: ExtensionContext): EffectiveConfig {
  if (!ctx.model) throw new Error("Parent has no selected model");
  return { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel(), cwd: ctx.cwd };
}

/** Getter is the shared entry point for later tools/UI; factory itself starts no resources. */
export function registerParentLifecycle(pi: ExtensionAPI, create?: (options: ManagerOptions) => ParentManager): {
  current(): ParentManager; recovery(): readonly RecoveryResult[];
  onStopping(cleanup: () => void): void;
} {
  const cleanups = new Set<() => void>();
  let manager: ParentManager | undefined;
  let starting: Promise<RecoveryResult[]> | undefined;
  let results: RecoveryResult[] = [];
  pi.on("session_start", async (_event, ctx) => {
    if (starting) { await starting; return; }
    const options: ManagerOptions = {
      agentDir: resolveAgentDir(ctx.cwd), parentSessionId: ctx.sessionManager.getSessionId(),
      driver: new TmuxProcessDriver({ entry: fileURLToPath(new URL("../index.ts", import.meta.url)) }),
    };
    manager = create ? create(options) : new ParentManager(options);
    starting = manager.recover();
    results = await starting;
    const failures = results.filter(result => !result.connected);
    if (failures.length) throw new AggregateError(failures.map(result => new Error(`${result.name}: ${result.error}`)), "Some subagents could not be recovered");
  });
  pi.on("session_shutdown", async event => {
    // UI must release old contexts/timers before potentially slow process stopping.
    try {
      for (const cleanup of cleanups) cleanup();
    } finally {
      cleanups.clear();
      await manager?.shutdown(event.reason);
    }
  });
  return {
    current: () => { if (!manager) throw new Error("Parent session has not started"); return manager; },
    recovery: () => results,
    onStopping: cleanup => { cleanups.add(cleanup); },
  };
}
