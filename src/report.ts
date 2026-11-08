import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReportReceiver, SubagentReport } from "./types.ts";

/** pi.sendMessage-compatible injection; async test/host delivery failures are caught too. */
export type ParentMessageSender = (
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
  options: Parameters<ExtensionAPI["sendMessage"]>[1],
) => void | Promise<void>;

export function createReportReceiver(sendMessage: ParentMessageSender): ReportReceiver {
  return (report: SubagentReport) => sendMessage({
    customType: "subagent.report",
    content: `Subagent: ${report.name}\n\n${report.text === null ? "(No assistant text available.)" : report.text}`,
    display: true,
  }, {
    deliverAs: "steer",
    triggerTurn: true,
  });
}
