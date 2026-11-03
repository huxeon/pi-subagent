import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { registerParentLifecycle } from "./parent-lifecycle.ts";
import { getSubagentPaths } from "./paths.ts";
import { tmuxSessionName } from "./process-driver.ts";
import { UiRefresh, type UiClock } from "./ui-refresh.ts";
import { renderWidget, SubagentPicker } from "./ui-components.ts";

/** Synchronous terminal handoff follows Pi's interactive-shell example. While
 * attached, the parent event loop cannot write UI or run shutdown concurrently. */
export function attachTerminal(tui: Pick<TUI, "stop" | "start" | "requestRender">, target: string,
  run: (target: string) => void = target => {
    const result = spawnSync("tmux", ["attach-session", "-t", target], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tmux attach-session failed (${result.signal ?? result.status})`);
  }): void {
  try {
    tui.stop();
    run(target);
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

export function registerParentUi(pi: ExtensionAPI, lifecycle: ReturnType<typeof registerParentLifecycle>, clock?: UiClock): void {
  let active: { refresh: UiRefresh; close(): void; signal: AbortSignal } | undefined;
  pi.on("session_start", (_event, ctx) => {
    active?.close();
    active = undefined;
    if (ctx.mode !== "tui") return; // hasUI also includes RPC: not sufficient.
    const refresh = new UiRefresh(lifecycle.current(), clock);
    const lifetime = new AbortController();
    let closed = false;
    const state = {
      refresh, signal: lifetime.signal,
      close() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        refresh.stop();
        ctx.ui.setWidget("subagents", undefined);
        if (active === state) active = undefined;
      },
    };
    active = state;
    lifecycle.onStopping(state.close);
    refresh.subscribe(() => {
      if (!refresh.snapshot.length) { ctx.ui.setWidget("subagents", undefined); return; }
      ctx.ui.setWidget("subagents", (_tui, theme) => ({
        render: width => renderWidget(refresh.snapshot, width, theme), invalidate() {},
      }), { placement: "belowEditor" });
    });
    refresh.start();
  });
  pi.registerCommand("subagent", {
    description: "Select and enter a subagent",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !active) return;
      const state = active;
      const manager = lifecycle.current();
      try {
        await state.refresh.settled(); // Only joins existing polling; opening UI never initiates a query.
        if (state.signal.aborted) return;
        if (state.refresh.error) throw new Error(state.refresh.error);
        if (!state.refresh.snapshot.length) { ctx.ui.notify("No subagents for this session.", "info"); return; }
        const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
          const picker = new SubagentPicker(theme, keys, done, () => tui.requestRender());
          picker.update(state.refresh.snapshot);
          const unsubscribe = state.refresh.subscribe(() => picker.update(state.refresh.snapshot));
          // Dispose is invoked by Pi on completion and runtime teardown.
          const cancel = () => done(undefined);
          state.signal.addEventListener("abort", cancel, { once: true });
          return {
            capturesViewportInput: true,
            render: width => picker.render(width), invalidate: () => picker.invalidate(),
            handleInput: data => picker.handleInput(data),
            dispose() { unsubscribe(); state.signal.removeEventListener("abort", cancel); },
          };
        }, { blocked: { kind: "question", message: "Select subagent" } });
        if (selected === undefined || state.signal.aborted) return;
        // Never enter from a stale UI cache. This is the existing direct query,
        // not another poller; a vanished/unavailable peer fails before handoff.
        await manager.inspect(selected, false, { timeoutMs: 600, signal: state.signal });
        if (state.signal.aborted) return;
        const paths = getSubagentPaths(manager.options.agentDir, manager.options.parentSessionId, selected);
        const target = `=${tmuxSessionName(paths.runDir)}`;
        if (process.env.TMUX) {
          const result = await pi.exec("tmux", ["switch-client", "-t", target], { timeout: 5000, signal: state.signal });
          if (result.code !== 0 || result.killed) throw new Error(`tmux switch-client failed: ${result.stderr || result.code}`);
        } else {
          const failure = await ctx.ui.custom<Error | undefined>((tui, _theme, _keys, done) => {
            let failure: Error | undefined;
            try { attachTerminal(tui, target); }
            catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
            done(failure);
            return { render: () => [], invalidate() {} };
          });
          if (failure) throw failure;
        }
      } catch (error) {
        if (!state.signal.aborted) ctx.ui.notify(`Could not enter subagent: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
