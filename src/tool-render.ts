import { getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import type { SubagentInput, ToolDetails, subagentSchema } from "./subagent-tool.ts";
import type { InspectResult } from "./child-bridge.ts";
import type { Availability } from "./types.ts";

export interface CardState { hasResult?: boolean }
export type CardContext = Parameters<NonNullable<ToolDefinition<typeof subagentSchema, ToolDetails, CardState>["renderCall"]>>[2];
type Context = CardContext;
// Never permit terminal control sequences from prompts, replies, names or errors.
// The original text is retained in arguments/details/model content.
const safe = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function lines(text: string, width: number): string[] {
  return new Text(safe(text), 0, 0).render(width).map(line => truncateToWidth(line, width));
}
function capped(rows: string[], limit: number, expanded: boolean, width: number, hint: string): string[] {
  if (expanded || rows.length <= limit) return rows;
  return [...rows.slice(0, limit), truncateToWidth(`... (${hint})`, width)];
}
function pending(p: SubagentInput): string {
  switch (p.operation) {
    case "spawn": return "Spawning...";
    case "send": return "Delivering...";
    case "list": return "Listing subagents...";
    case "status": return "Checking status...";
    case "wait": return "Waiting for completion...";
    case "stop": return "Stopping...";
    default: return "Operation in progress...";
  }
}
function status(value: Availability): string {
  return value.available ? value.workState : value.reason === "connection-error" ? `✗ Connection error: ${value.error.message}` : value.reason;
}

/** A pure, replayable transcript card: no manager/socket/UI lookup, even on reload. */
export function card(p: SubagentInput, details: ToolDetails | undefined, context: Context, theme: Theme, fallback?: string): Component {
  p = p && typeof p === "object" && !Array.isArray(p) ? p : {} as SubagentInput;
  let markdown: Markdown | undefined;
  let markdownText: string | undefined;
  return {
    invalidate() { markdown?.invalidate(); },
    render(width) {
      if (width < 1) return [];
      const expanded = context.expanded;
      const hint = context.keyHint("app.tools.expand", "to expand") || "expand to view full content";
      const operationText = typeof p.operation === "string" ? ` ${safe(p.operation)}` : "";
      const options: string[] = [];
      if (p.operation === "send" && p.followUp === true) {
        options.push("follow-up");
      } else if (p.operation === "wait") {
        options.push(`timeout ${p.timeout ?? 1800}s`);
      }
      const nameText = typeof p.name === "string" ? ` ${safe(p.name)}` : "";
      const optionText = options.length ? theme.fg("muted", safe(` (${options.join(", ")})`)) : "";
      const title = theme.fg("toolTitle", theme.bold("subagent") + operationText) + nameText + optionText;
      let output = new Text(title, 0, 0).render(width).map(line => truncateToWidth(line, width));
      if ((p.operation === "spawn" || p.operation === "send") && typeof p.prompt === "string") {
        const prompt = capped(lines(p.prompt, Math.max(1, width - 2)), 3, expanded, Math.max(1, width - 2), hint);
        output = output.concat(prompt.map(line => truncateToWidth(`  ${line}`, width)));
      }
      if (p.operation === "spawn") {
        const cwd = details?.config?.cwd ?? resolve(context.cwd, typeof p.cwd === "string" && !p.cwd.includes("\0") ? p.cwd : ".");
        output = output.concat(lines(`  cwd: ${cwd}`, width));
      }
      output.push("");
      const add = (text: string, color?: "success" | "error" | "warning") => {
        const rows = capped(lines(text, width), 8, expanded, width, hint);
        output = output.concat(color ? rows.map(row => theme.fg(color, row)) : rows);
      };
      if (!details) {
        if (fallback !== undefined) add(`${context.isError ? "✗ " : ""}${fallback}`, context.isError ? "error" : undefined);
        else add(pending(p));
      } else if (details.phase === "running") add(pending(p));
      else if (details.phase === "cancelled") {
        add(p.operation === "wait" ? "Wait cancelled. Subagent continues running." : "Operation cancelled. Some effects may already have occurred.");
      } else if (details.phase === "timeout" || details.phase === "error") {
        const error = details.error;
        if (details.phase === "timeout" && error?.code === "TIMEOUT" && p.operation === "wait") add(`✗ Wait timed out after ${p.timeout ?? 1800}s. Subagent continues running.`, "error");
        else if (["CONNECTION_CLOSED", "ECONNRESET", "EPIPE"].includes(error?.code ?? "")) add("✗ Connection lost. Subagent status is unknown.", "error");
        else add(`✗ ${error?.message ?? "Operation failed."}`, "error");
      } else {
        switch (p.operation) {
          case "spawn": {
            const c = details.config;
            add(c ? `✓ Spawned · ${c.provider}/${c.model}:${c.thinking}` : "✗ Missing spawn configuration.", c ? "success" : "error"); break;
          }
          case "send": add("✓ Delivered", "success"); break;
          case "stop": add("✓ Stopped · session data deleted", "success"); break;
          case "list": {
            const items = Array.isArray(details.data) ? details.data : [];
            const nameWidth = Math.min(24, Math.max(0, ...items.map(item => visibleWidth(safe(item.name)))));
            add(items.length ? items.map(item => `${item.name}${" ".repeat(Math.max(2, nameWidth - visibleWidth(safe(item.name)) + 2))}${status(item.status)}`).join("\n") : "No subagents.");
            break;
          }
          case "status": {
            const data = details.data as InspectResult | undefined;
            add(data?.state ?? "Status unavailable.");
            break;
          }
          case "wait": {
            const data = details.data as InspectResult | undefined;
            const reply = data && "reply" in data ? data.reply : null;
            if (reply?.stopReason === "error") { add(`✗ Assistant error${reply.errorMessage ? `: ${reply.errorMessage}` : "."}`, "error"); output.push(""); }
            else if (reply?.stopReason === "aborted") { add(`Assistant response aborted.${reply.errorMessage ? ` ${reply.errorMessage}` : ""}`, "warning"); output.push(""); }
            else if (reply?.errorMessage) { add(`✗ ${reply.errorMessage}`, "error"); output.push(""); }
            if (reply?.text) {
              const text = safe(reply.text);
              if (markdownText !== text) { markdownText = text; markdown = new Markdown(text, 0, 0, getMarkdownTheme()); }
              output = output.concat(capped(markdown!.render(width).map(row => truncateToWidth(row, width)), 10, expanded, width, hint));
            } else add("No assistant reply.");
            break;
          }
          default:
            // Historical calls keep their stored content readable without
            // accepting legacy operation names in the executable tool schema.
            add(fallback || "Result unavailable.");
        }
      }
      return output.map(row => truncateToWidth(row, width));
    },
  };
}

export const toolRenderers = {
  renderCall(args: SubagentInput, theme: Theme, context: Context): Component {
    const initial = card(args, undefined, context, theme);
    // Pi composes slots before rendering them. Reading shared row state here
    // avoids a duplicate header and lets partial/final details own the whole card.
    return { render: width => context.state.hasResult ? [] : initial.render(width), invalidate: () => initial.invalidate() };
  },
  renderResult(result: { details?: ToolDetails; content: Array<{ type: string; text?: string }> }, _options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: Context): Component {
    context.state.hasResult = true;
    const fallback = result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
    // Pi-generated validation/blocked/thrown/aborted results may have no details.
    // They remain visibly errors, not fabricated successful cards.
    const details = result.details?.version === 1 && ["running", "done", "error", "cancelled", "timeout"].includes(result.details.phase) ? result.details : undefined;
    if (!details && fallback === "Operation aborted") {
      return card(context.args, { version: 1, phase: "cancelled" }, context, theme);
    }
    return card(context.args, details, context, theme, fallback);
  },
};
