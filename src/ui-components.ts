import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, visibleWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { UiEntry } from "./ui-refresh.ts";

const safe = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
export const statusText = (entry: UiEntry): string => entry.status.available ? entry.status.workState : "unavailable";
function statusLabel(entry: UiEntry, theme: Theme): string {
  return theme.fg(entry.status.available ? entry.status.workState === "working" ? "warning" : "success" : "muted", statusText(entry));
}
export function renderWidget(entries: readonly UiEntry[], width: number, theme: Theme): string[] {
  if (!entries.length || width <= 0) return [];
  const prefix = theme.fg("dim", "subagents: ");
  // Reserve room for the remainder even at narrow widths. Cap both names and count.
  for (let count = Math.min(5, entries.length); count >= 1; count--) {
    const remainder = count < entries.length ? theme.fg("dim", ` | +${entries.length - count} more`) : "";
    const budget = width - visibleWidth(prefix + remainder) - (count - 1) * 3;
    const cell = Math.floor(budget / count);
    if (cell < 14) continue;
    const labels = entries.slice(0, count).map(entry => {
      const status = statusLabel(entry, theme);
      const name = truncateToWidth(safe(entry.name), Math.max(1, cell - visibleWidth(status) - 1));
      return `${name}:${status}`;
    });
    return [truncateToWidth(prefix + labels.join(theme.fg("dim", " | ")) + remainder, width)];
  }
  return [truncateToWidth(theme.fg("dim", `subagents: ${entries.length} (open /subagent)`), width)];
}

/** Selection is keyed by exact name, never by a changing array index. */
export class SubagentPicker implements Component {
  readonly capturesViewportInput = true;
  selectedName: string | undefined;
  private entries: readonly UiEntry[] = [];
  private rows: UiEntry[] = [];
  private list: SelectList | undefined;
  private initialized = false;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (name: string | undefined) => void;
  private readonly requestRender: () => void;
  constructor(theme: Theme, keys: KeybindingsManager, done: (name: string | undefined) => void, requestRender: () => void) {
    this.theme = theme; this.keys = keys; this.done = done; this.requestRender = requestRender;
  }
  update(entries: readonly UiEntry[]): void {
    this.entries = entries;
    if (!this.initialized) { this.selectedName = entries[0]?.name; this.initialized = true; }
    this.rows = [...entries];
    if (this.selectedName !== undefined && !entries.some(entry => entry.name === this.selectedName)) {
      // Keep a non-enterable tombstone until explicit navigation. Never silently
      // select the next collaborator when the selected one is destroyed.
      this.rows.push({ name: this.selectedName, status: { available: false, reason: "unavailable" } });
    }
    const theme = this.theme;
    this.list = new SelectList(this.rows.map(entry => ({ value: entry.name,
      label: `${safe(entry.name)}:${statusText(entry)}` })), 8, {
      selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
      description: text => theme.fg(text === "working" ? "warning" : text === "idle" ? "success" : "muted", text),
      scrollInfo: text => theme.fg("dim", text), noMatch: text => theme.fg("muted", text),
    }, {
      truncatePrimary: ({ item, maxWidth }) => {
        const entry = this.rows.find(entry => entry.name === item.value)!;
        const status = statusLabel(entry, theme);
        const budget = maxWidth - visibleWidth(status) - 1;
        if (budget < 1) return truncateToWidth(`${safe(entry.name)}:${status}`, maxWidth);
        return `${truncateToWidth(safe(entry.name), budget)}:${status}`;
      },
    });
    this.list.setSelectedIndex(Math.max(0, this.rows.findIndex(entry => entry.name === this.selectedName)));
    this.requestRender();
  }
  render(width: number): string[] {
    const hint = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => this.keys.getKeys(action).join("/");
    return [this.theme.fg("accent", "Select subagent"),
      ...(this.rows.length ? this.list!.render(width) : [this.theme.fg("muted", "No subagents.")]),
      this.theme.fg("dim", `${hint("tui.select.up")}/${hint("tui.select.down")} move · ${hint("tui.select.confirm")} select · ${hint("tui.select.cancel")} cancel`),
    ].map(line => truncateToWidth(line, Math.max(0, width)));
  }
  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) { this.done(undefined); return; }
    if (this.keys.matches(data, "tui.select.confirm")) {
      if (this.entries.some(entry => entry.name === this.selectedName && entry.status.available)) this.done(this.selectedName);
      return;
    }
    let delta = 0;
    if (this.keys.matches(data, "tui.select.up")) delta = -1;
    else if (this.keys.matches(data, "tui.select.down")) delta = 1;
    else if (this.keys.matches(data, "tui.select.pageUp")) delta = -8;
    else if (this.keys.matches(data, "tui.select.pageDown")) delta = 8;
    if (!delta || !this.rows.length) return;
    const index = this.rows.findIndex(entry => entry.name === this.selectedName);
    const next = Math.max(0, Math.min(this.rows.length - 1, index + delta));
    this.selectedName = this.rows[next]!.name;
    this.list?.setSelectedIndex(next);
    this.requestRender();
  }
  invalidate(): void { this.list?.invalidate(); }
}
