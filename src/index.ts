import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./manager.ts";
import type { SubagentManagerOptions } from "./manager.ts";
import { registerSubagentTool } from "./tools.ts";
import { createStatusWidget } from "./ui.ts";
import { renderSubagentReport } from "./render.ts";

/** The optional client seam is for controlled hosts/tests; Pi calls this with only pi. */
export default function extension(
  pi: ExtensionAPI,
  options: Pick<SubagentManagerOptions, "createClient"> = {},
): void {
  // Construction has no background resources; each factory call owns a fresh runtime.
  const widget = createStatusWidget();
  const manager = new SubagentManager({
    createClient: options.createClient,
    sendMessage: (message, delivery) => pi.sendMessage(message, delivery),
    onStatusChange: (statuses) => widget.update(statuses),
  });
  registerSubagentTool(pi, manager);
  pi.registerMessageRenderer("subagent.report", renderSubagentReport);
  pi.on("session_start", (_event, ctx) => { widget.connect(ctx); });
  pi.on("session_shutdown", async () => {
    widget.dispose();
    await manager.shutdown();
  });
}
