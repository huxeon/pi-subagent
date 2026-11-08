import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { MessageRenderer, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { SubmissionDetails } from "./types.ts";

const TASK_PREVIEW_LINES = 3;
const REPORT_PREVIEW_LINES = 8;

/** Display only: never mutate original tool arguments, results or report content. */
function displayText(value: string, multiline = false): string {
  return stripTerminalSequences(value)
    .replace(/\t/g, multiline ? "   " : " ")
    .replace(multiline ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\u2028\u2029]/g, multiline ? "\n" : " ");
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

/** Keep all output within the terminal's cell width, even for tiny widths/code blocks. */
function bounded(component: Component): Component {
  return {
    render(width) { return width < 1 ? [] : component.render(width).map((line) => truncateToWidth(line, width, "...")); },
    invalidate() { component.invalidate(); },
  };
}
function preview(
  component: Component, maxLines: number, expanded: boolean, theme: Theme,
  keyHint: (id: "app.tools.expand", description: string) => string,
): Component {
  return {
    render(width) {
      if (width < 1) return [];
      const lines = component.render(width);
      if (expanded || lines.length <= maxLines) return lines;
      const hint = theme.fg("muted", `... (${lines.length - maxLines} more lines, ${keyHint("app.tools.expand", "to expand")})`);
      return [...lines.slice(0, maxLines), truncateToWidth(hint, width, "...")];
    },
    invalidate() { component.invalidate(); },
  };
}
function textOutput(content: { type: string; text?: string }[]): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

export const subagentToolRenderers: Pick<ToolDefinition<any, SubmissionDetails | undefined>, "renderCall" | "renderResult"> = {
  renderCall(args, theme, context) {
    const input = object(args);
    const parts = ["subagent", string(input.action), string(input.name)].filter(Boolean).map((part) => displayText(part));
    // Read the former mode only when rendering historical calls, never when executing new ones.
    const followUp = input.action === "send" && (input.followUp === true ||
      (input.followUp === undefined && input.mode === "followUp"));
    const component = new Container();
    component.addChild(new Text(theme.bold(parts.join(" ")) + (followUp ? " (follow-up)" : ""), 0, 0));
    const message = string(input.message);
    if (message) component.addChild(preview(new Text(displayText(message, true), 0, 0),
      TASK_PREVIEW_LINES, context.expanded, theme, context.keyHint));
    return bounded(component);
  },
  renderResult(result, options, theme, context) {
    const component = new Container();
    if (options.isPartial) return component; // No acceptance icon before the submission finishes.
    const output = textOutput(result.content);
    if (context.isError) {
      const error = displayText(output || "Submission failed.", true);
      const styled = error.split("\n").map((line, index) => theme.fg("error", (index === 0 ? "✗ " : "") + line)).join("\n");
      component.addChild(new Spacer(1));
      component.addChild(preview(new Text(styled, 0, 0), TASK_PREVIEW_LINES, options.expanded, theme, context.keyHint));
      return bounded(component);
    }
    const details = object(result.details);
    const disposition = details.disposition;
    if (disposition !== "started" && disposition !== "queued" && disposition !== "handled") {
      // Older/third-party results without known metadata: show content without inventing acceptance.
      if (output) component.addChild(new Text(displayText(output, true), 0, 0));
      return bounded(component);
    }
    let footer = `${theme.fg("success", "✓")} ${disposition[0].toUpperCase()}${disposition.slice(1)}`;
    const config = object(details.config);
    if (object(context.args).action === "spawn" && [config.provider, config.model, config.thinking].every((part) => typeof part === "string")) {
      footer += ` ${displayText(`${config.provider}/${config.model}:${config.thinking}`)}`;
    }
    component.addChild(new Spacer(1));
    component.addChild(new Text(footer, 0, 0));
    return bounded(component);
  },
};

export const renderSubagentReport: MessageRenderer = (message, options, theme) => {
  const report = object(message.details);
  if (typeof report.name !== "string" || (report.text !== null && typeof report.text !== "string")) return undefined;
  const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(theme.bold(`subagent report ${displayText(report.name)}`), 0, 0));
  const text = report.text === null ? "(No assistant text available.)" : report.text;
  if (text !== "") {
    box.addChild(new Spacer(1));
    box.addChild(preview(new Markdown(displayText(text, true), 0, 0, getMarkdownTheme()),
      REPORT_PREVIEW_LINES, options.expanded, theme, options.keyHint));
  }
  return bounded(box);
};
