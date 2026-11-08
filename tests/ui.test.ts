import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createStatusWidget, renderStatusLines, STATUS_WIDGET_KEY } from "../src/ui.ts";
import type { SubagentStatus } from "../src/types.ts";

const statuses: readonly SubagentStatus[] = [
  { name: "reviewer", state: "running" }, { name: "coder", state: "idle" },
];
const plainTheme: Pick<Theme, "fg"> = { fg: (_token, text) => text };

test("status widget compact layout retains names, both labels and creation order", () => {
  assert.deepEqual(renderStatusLines(statuses, 80, plainTheme), ["Subagents  reviewer · working | coder · idle"]);
  assert.deepEqual(renderStatusLines([], 80, plainTheme), []);
  assert.deepEqual(renderStatusLines(statuses, 0, plainTheme), []);
});

test("state labels use distinct theme colors and vertical dividers use dim", () => {
  const codes = { warning: 33, success: 32, dim: 90, muted: 37 };
  const theme: Pick<Theme, "fg"> = { fg: (token, text) => `\x1b[${codes[token as keyof typeof codes]}m${text}\x1b[0m` };
  const [line] = renderStatusLines(statuses, 80, theme);
  assert.ok(line.includes("\x1b[33mworking\x1b[0m"));
  assert.ok(line.includes("\x1b[32midle\x1b[0m"));
  assert.ok(line.includes("\x1b[90m | \x1b[0m"));
  assert.equal(stripTerminalSequences(line), "Subagents  reviewer · working | coder · idle");
});

test("layout wraps whole entries, truncates long names, and fits narrow, CJK, emoji and combining widths", () => {
  assert.deepEqual(renderStatusLines(statuses, 32, plainTheme), [
    "Subagents  reviewer · working", "  coder · idle",
  ]);
  const names: SubagentStatus[] = [
    { name: "审查员👩‍💻".repeat(20), state: "running" },
    { name: "e\u0301".repeat(40), state: "idle" },
    { name: "tester", state: "running" },
  ];
  for (const width of [1, 2, 3, 6, 10, 12, 17, 18, 20, 23, 24, 32, 40, 80, 200]) {
    const lines = renderStatusLines(names, width, plainTheme);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.doesNotMatch(line.trim(), /^\||\|$/, "no orphan dividers at wrap boundaries");
    }
  }
  const lines = renderStatusLines(names, 40, plainTheme);
  assert.ok(lines[0].includes("..."));
  assert.ok(lines[0].endsWith("working"));
  assert.ok(lines[1].endsWith("idle"));
});

test("name control sequences are display-only sanitized and cannot inject terminal output or lines", () => {
  const name = "raw\n\t\x1b[31mred\x1b[0m\x1b]0;title\x07\r\x00\u0085\u2028\u2029end";
  const input: SubagentStatus[] = [{ name, state: "idle" }];
  const [line] = renderStatusLines(input, 120, plainTheme);
  assert.match(line, /raw red/);
  assert.match(line, /end · idle$/);
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028\u2029]/);
  assert.doesNotMatch(line, /title/);
  assert.equal(input[0].name, name);
});

test("component is TUI-only, clears empty/disposed widgets and renders current theme and width", () => {
  type Factory = (tui: TUI, theme: Theme) => Component;
  const calls: { key: string; content: Factory | undefined; placement?: string }[] = [];
  const ui = { setWidget(key: string, content: Factory | undefined, options?: { placement: string }) {
    calls.push({ key, content, placement: options?.placement });
  } };
  const ctx = { mode: "tui", ui } as unknown as ExtensionContext;
  const widget = createStatusWidget();
  widget.update(statuses);
  assert.equal(calls.length, 0, "no UI work before session_start");
  for (const mode of ["rpc", "json", "print"] as const) {
    widget.connect({ mode, get ui() { throw new Error("non-TUI UI accessed"); } } as unknown as ExtensionContext);
  }
  assert.equal(calls.length, 0);
  widget.connect(ctx);
  assert.equal(calls.at(-1)!.key, STATUS_WIDGET_KEY);
  assert.equal(calls.at(-1)!.placement, "aboveEditor");
  let color = 31;
  const theme = { fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[0m` } as Theme;
  const component = calls.at(-1)!.content!({} as TUI, theme);
  assert.deepEqual(component.render(80).map(stripTerminalSequences), renderStatusLines(statuses, 80, plainTheme));
  assert.ok(component.render(80)[0].includes("\x1b[31m"));
  color = 34;
  component.invalidate();
  assert.ok(component.render(80)[0].includes("\x1b[34m"), "theme styling is computed at render time");
  assert.equal(component.render(32).length, 2, "resize recomputes wrapping");
  for (const line of component.render(12)) assert.ok(visibleWidth(line) <= 12);
  widget.update([]);
  assert.equal(calls.at(-1)!.content, undefined);
  widget.update(statuses);
  widget.dispose();
  assert.equal(calls.at(-1)!.content, undefined);
  const count = calls.length;
  widget.update(statuses);
  widget.dispose();
  assert.equal(calls.length, count, "late updates cannot revive a disposed session UI");
});
