import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentReport, subagentToolRenderers } from "../src/render.ts";
import type { SubmissionDetails } from "../src/types.ts";

initTheme("dark", false); // No watchers or terminal/model interaction.
const renderCall = subagentToolRenderers.renderCall!;
const renderResult = subagentToolRenderers.renderResult!;
type Context = Parameters<typeof renderCall>[2];
const theme = {
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  fg: (token: string, text: string) => `\x1b[${token === "success" ? 32 : token === "error" ? 31 : 90}m${text}\x1b[0m`,
  bg: (_token: string, text: string) => text,
} as Theme;
const spawn = { action: "spawn", name: "reviewer", message: "Review concurrency." } as const;
const config = { provider: "provider", model: "model", thinking: "high" } as const;
function context(args: unknown = spawn, changes: Partial<Context> = {}): Context {
  return { args, toolCallId: "call", cwd: "/work", executionStarted: true, argsComplete: true,
    isPartial: false, expanded: false, showImages: false, isError: false, outputPad: 1,
    durationMs: undefined, lastComponent: undefined, state: {}, invalidate() {},
    keyText: () => "custom-key", keyHint: (_id, text) => `custom-key ${text}`, ...changes };
}
const options: MessageRenderOptions = { expanded: false, outputPad: 1,
  keyText: () => "custom-key", keyHint: (_id, text) => `custom-key ${text}` };
const plain = (component: Component, width = 100) => component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
function report(text: string | null, name = "reviewer") {
  return { role: "custom", customType: "subagent.report", content: `Subagent: ${name}\n\n${text ?? "(No assistant text available.)"}`,
    details: { name, text }, display: true, timestamp: 0 } as const;
}
function fits(component: Component, widths = [1, 2, 4, 8, 16, 24, 40, 100]) {
  for (const width of widths) {
    for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width=${width}: ${line}`);
  }
  assert.deepEqual(component.render(0), []);
}

test("tool title is entirely bold, space-separated and uncolored; follow-up is a plain optional suffix", () => {
  const call = renderCall(spawn, theme, context());
  assert.deepEqual(plain(call), ["subagent spawn reviewer", "Review concurrency."]);
  const header = call.render(100)[0];
  assert.ok(header.startsWith("\x1b[1msubagent spawn reviewer\x1b[22m"));
  assert.doesNotMatch(header, /\x1b\[3[0-9]m/);
  for (const followUp of [undefined, false, true]) {
    const args = { ...spawn, action: "send", followUp };
    const component = renderCall(args, theme, context(args));
    assert.equal(plain(component)[0], `subagent send reviewer${followUp ? " (follow-up)" : ""}`);
    if (followUp) assert.ok(component.render(100)[0].includes("reviewer\x1b[22m (follow-up)"));
  }
});

test("task previews limit visual rather than logical lines and expand using the configured key hint", () => {
  const args = { ...spawn, message: "word ".repeat(100) + "THE-END" };
  const collapsed = renderCall(args, theme, context(args));
  const expanded = renderCall(args, theme, context(args, { expanded: true }));
  assert.equal(collapsed.render(50).length, 5, "one title + three task lines + hint");
  assert.match(plain(collapsed, 50).at(-1)!, /^\.\.\. \(/);
  assert.match(plain(collapsed, 50).at(-1)!, /custom-key to expand/);
  assert.ok(!plain(collapsed, 50).join("\n").includes("THE-END"));
  assert.ok(plain(expanded, 50).join("\n").includes("THE-END"));
  fits(collapsed);
});

test("success footers show every capitalized disposition, and only spawn includes the resolved config", () => {
  for (const disposition of ["started", "queued", "handled"] as const) {
    const details: SubmissionDetails = { name: spawn.name, disposition, config };
    const result = { content: [{ type: "text" as const, text: JSON.stringify({ name: spawn.name, disposition }) }], details };
    const capitalized = disposition[0].toUpperCase() + disposition.slice(1);
    const spawned = renderResult(result, { expanded: false, isPartial: false }, theme, context());
    assert.deepEqual(plain(spawned), ["", `✓ ${capitalized} provider/model:high`]);
    assert.ok(spawned.render(100)[1].includes("\x1b[32m✓\x1b[0m"));
    const sent = renderResult(result, { expanded: false, isPartial: false }, theme, context({ action: "send" }));
    assert.deepEqual(plain(sent), ["", `✓ ${capitalized}`]);
    assert.deepEqual(renderResult(result, { expanded: false, isPartial: true }, theme, context()).render(100), []);
    fits(spawned);
  }
});

test("errors show a cross and reason without inventing a disposition, including validation errors with no details", () => {
  const result = { content: [{ type: "text" as const, text: "Unknown subagent reviewer" }], details: undefined };
  const component = renderResult(result, { expanded: false, isPartial: false }, theme, context(spawn, { isError: true }));
  assert.deepEqual(plain(component), ["", "✗ Unknown subagent reviewer"]);
  assert.ok(component.render(100)[1].includes("\x1b[31m✗"));
  assert.doesNotMatch(plain(component).join("\n"), /✓|Started|Queued|Handled/);
  fits(component);
});

test("old or incomplete tool metadata does not crash or fabricate inherited model config", () => {
  for (const args of [undefined, null, {}, { action: "spawn" }, { name: "r" }, { message: 3 }, []]) {
    fits(renderCall(args, theme, context(args)));
  }
  const legacy = { ...spawn, action: "send", mode: "followUp" };
  assert.match(plain(renderCall(legacy, theme, context(legacy)))[0], /\(follow-up\)$/);
  const oldResult = { content: [], details: { name: "reviewer", disposition: "started" as const } };
  assert.deepEqual(plain(renderResult(oldResult, { expanded: false, isPartial: false }, theme, context())), ["", "✓ Started"]);
  const unknown = { content: [{ type: "text" as const, text: "external result" }], details: undefined };
  assert.deepEqual(plain(renderResult(unknown, { expanded: false, isPartial: false }, theme, context())), ["external result"]);
});

test("report uses structured data, renders Markdown and leaves model-facing content unchanged", () => {
  const message = { ...report("**Finding**\n\n- race in `shutdown`\n\n```ts\nconst x = 1;\n```"), content: "not parsed as a header" };
  const component = renderSubagentReport(message, { ...options, expanded: true }, theme)!;
  const rendered = plain(component).join("\n");
  assert.match(rendered, /subagent report reviewer/);
  assert.match(rendered, /Finding/);
  assert.match(rendered, /race in shutdown/);
  assert.match(rendered, /const x = 1/);
  assert.doesNotMatch(rendered, /\*\*Finding\*\*|not parsed as a header/);
  assert.equal(message.content, "not parsed as a header");
  fits(component);
});

test("report previews cap body visual lines at eight, expand fully and respect output padding", () => {
  const message = report(Array.from({ length: 25 }, (_, i) => `Line-${i}`).join("\n\n"));
  const collapsed = renderSubagentReport(message, options, theme)!;
  const expanded = renderSubagentReport(message, { ...options, expanded: true }, theme)!;
  const lines = plain(collapsed);
  assert.ok(lines.length <= 13, "top pad + header + blank + eight body lines + hint + bottom pad");
  assert.match(lines.join("\n"), /custom-key to expand/);
  assert.ok(!lines.join("\n").includes("Line-24"));
  assert.ok(plain(expanded).join("\n").includes("Line-24"));
  const padded = renderSubagentReport(report("body"), { ...options, outputPad: 4 }, theme)!;
  assert.ok(plain(padded)[1].startsWith("    subagent report"));
  fits(collapsed);
});

test("null and empty reports remain distinct; missing or invalid details fall back to Pi", () => {
  assert.match(plain(renderSubagentReport(report(null), options, theme)!).join("\n"), /No assistant text available/);
  const empty = plain(renderSubagentReport(report(""), options, theme)!).join("\n");
  assert.match(empty, /subagent report reviewer/);
  assert.doesNotMatch(empty, /No assistant text available/);
  for (const details of [undefined, null, {}, { name: "r" }, { name: 1, text: "result" }, { name: "r", text: [] }]) {
    assert.equal(renderSubagentReport({ ...report("result"), details }, options, theme), undefined);
  }
});

test("display sanitization handles multiline names, ANSI, OSC, CJK and emoji without mutating input", () => {
  const name = "审查员👩‍💻\n\x1b[31mred\x1b[0m\x1b]0;title\x07";
  const args = { ...spawn, name, message: "task\x00\x07\nnext" };
  const component = renderCall(args, theme, context(args));
  const output = plain(component).join("\n");
  assert.match(output, /subagent spawn 审查员👩‍💻 red/);
  assert.doesNotMatch(output, /title|\x00|\x07/);
  assert.equal(args.name, name);
  fits(component);
  const message = report("result\x00\x07\n\n**中文👩‍💻**", name);
  const rendered = renderSubagentReport(message, options, theme)!;
  assert.doesNotMatch(plain(rendered).join("\n"), /title|\x00|\x07/);
  assert.equal(message.details.name, name);
  fits(rendered);
});

test("native Pi tool/message components use the renderers for progress, errors, expansion and theme invalidation", () => {
  const ui = { requestRender() {} } as TUI;
  const tool = new ToolExecutionComponent("subagent", "call", spawn, { outputPad: 2 }, subagentToolRenderers, ui, "/work");
  assert.match(plain(tool).join("\n"), /subagent spawn reviewer/);
  assert.doesNotMatch(plain(tool).join("\n"), /✓/);
  tool.updateResult({ content: [], details: { name: "reviewer", disposition: "started", config }, isError: false });
  assert.match(plain(tool).join("\n"), /✓ Started provider\/model:high/);
  tool.updateResult({ content: [{ type: "text", text: "compaction in progress" }], isError: true });
  assert.match(plain(tool).join("\n"), /✗ compaction in progress/);
  tool.setExpanded(true);
  tool.invalidate();
  assert.match(plain(tool).join("\n"), /✗ compaction in progress/);

  const message = report(Array.from({ length: 20 }, (_, i) => `part-${i}`).join("\n\n"));
  const custom = new CustomMessageComponent(message, renderSubagentReport);
  assert.match(plain(custom).join("\n"), /subagent report reviewer/);
  assert.doesNotMatch(plain(custom).join("\n"), /part-19/);
  custom.setExpanded(true);
  assert.match(plain(custom).join("\n"), /part-19/);
  initTheme("light", false);
  custom.invalidate();
  assert.match(plain(custom).join("\n"), /part-19/);
  initTheme("dark", false);
  const oldMessage = new CustomMessageComponent({ ...report("old content"), details: undefined }, renderSubagentReport);
  assert.match(plain(oldMessage).join("\n"), /old content/);
});
