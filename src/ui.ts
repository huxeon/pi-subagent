import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  replaceControlCharacters, stripTerminalSequences, truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentStatus } from "./types.ts";

export const STATUS_WIDGET_KEY = "subagent.status";

/** Width-aware, display-only layout; names in the manager are never normalized. */
export function renderStatusLines(
  statuses: readonly SubagentStatus[], width: number, theme: Pick<Theme, "fg">,
): string[] {
  if (width < 1 || statuses.length === 0) return [];
  const lines: string[] = [];
  const divider = theme.fg("dim", " | ");
  let line = width >= 24 ? theme.fg("muted", "Subagents") + "  " : "";
  let hasEntry = false;
  for (const { name, state } of statuses) {
    const cleaned = replaceControlCharacters(stripTerminalSequences(name)).replace(/[\u2028\u2029]/g, " ");
    const displayName = cleaned.trim() ? cleaned : "?";
    const label = theme.fg(state === "running" ? "warning" : "success", state === "running" ? "working" : "idle");
    const suffix = theme.fg("dim", " · ") + label;
    if (hasEntry && visibleWidth(line) + visibleWidth(divider) + visibleWidth(displayName + suffix) > width) {
      lines.push(line);
      line = width >= 12 ? "  " : "";
      hasEntry = false;
    }
    const separator = hasEntry ? divider : "";
    const available = width - visibleWidth(line + separator);
    const nameWidth = available - visibleWidth(suffix);
    // Preserve the state label when possible, including on very narrow terminals.
    const entry = nameWidth > 0
      ? truncateToWidth(displayName, nameWidth, "...") + suffix
      : truncateToWidth(label, available, "...");
    line += separator + entry;
    hasEntry = true;
  }
  lines.push(line);
  return lines;
}

/** One runtime's widget. No timers, RPC requests, session entries or model messages. */
export function createStatusWidget() {
  let ui: ExtensionContext["ui"] | undefined;
  let statuses: readonly SubagentStatus[] = [];
  function refresh() {
    if (!ui) return;
    if (statuses.length === 0) {
      ui.setWidget(STATUS_WIDGET_KEY, undefined);
      return;
    }
    const snapshot = statuses;
    ui.setWidget(STATUS_WIDGET_KEY, (_tui, theme) => ({
      render: (width) => renderStatusLines(snapshot, width, theme),
      // No cache: resize/theme invalidation naturally recomputes layout and colors.
      invalidate() {},
    }), { placement: "aboveEditor" });
  }
  return {
    connect(ctx: ExtensionContext) {
      if (ctx.mode !== "tui") return;
      ui = ctx.ui;
      refresh();
    },
    update(next: readonly SubagentStatus[]) {
      statuses = next.map((status) => ({ ...status }));
      refresh();
    },
    dispose() {
      const previous = ui;
      ui = undefined; // Late manager updates cannot touch a stale session UI.
      statuses = [];
      try { previous?.setWidget(STATUS_WIDGET_KEY, undefined); } catch { /* Cleanup remains best effort. */ }
    },
  };
}
