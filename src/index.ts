import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildBridge } from "./child-bridge.ts";
import { normalizeAbsolutePath } from "./paths.ts";
import { registerParentLifecycle } from "./parent-lifecycle.ts";
import { registerSubagentTool } from "./subagent-tool.ts";
import { registerParentUi } from "./parent-ui.ts";

export default function subagentExtension(pi: ExtensionAPI): void {
  const runDir = process.env.PI_SUBAGENT_RUN_DIR;
  if (runDir !== undefined) {
    // Presence means child role; invalid/relative values fail rather than becoming a parent.
    registerChildBridge(pi, normalizeAbsolutePath(runDir));
    return;
  }
  const lifecycle = registerParentLifecycle(pi);
  registerSubagentTool(pi, lifecycle);
  registerParentUi(pi, lifecycle);
}
