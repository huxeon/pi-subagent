// Controlled Pi stand-in: real production child entry/socket + native SessionManager,
// but synthetic events and replies. No AgentSession, provider transport or model calls.
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../../index.ts";
import type { EffectiveConfig } from "../../src/session-record.ts";

const config = JSON.parse(process.env.TEST_CONFIG!) as EffectiveConfig;
const sm = SessionManager.open(process.env.PI_SUBAGENT_SESSION_FILE!, undefined, config.cwd);
if (!sm.buildSessionContext().model) {
  sm.appendModelChange(config.provider, config.model);
  sm.appendThinkingLevelChange(config.thinking);
}
let idle = true;
let reads = 0;
const deliveries: Array<{ prompt: unknown; delivery: unknown }> = [];
const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
const emit = async (name: string, event = {}) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
const pi = {
  on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
  getThinkingLevel: () => config.thinking,
  sendUserMessage(prompt: string, delivery: unknown) {
    deliveries.push({ prompt, delivery: delivery ?? null });
    sm.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
    idle = false;
    void emit("agent_start");
  },
  // Unexpected parent registration is a hard failure, not a silent no-op.
  registerTool() { throw new Error("Child registered parent tool"); },
  registerCommand() { throw new Error("Child registered parent UI"); },
} as unknown as ExtensionAPI;
const ctx = {
  cwd: config.cwd, model: { provider: config.provider, id: config.model },
  isIdle: () => idle,
  sessionManager: {
    getSessionFile: () => sm.getSessionFile(),
    getBranch: () => { reads++; return sm.getBranch(); },
  },
  get ui() { throw new Error("Child accessed parent UI"); },
} as unknown as ExtensionContext;
extension(pi);
await emit("session_start");
process.send!({ ready: true });
// Commands are test-only IPC; never added to the production socket protocol.
process.on("message", async (message: { id: number; command: string; text?: string }) => {
  try {
    if (message.command === "settle") {
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: message.text! }],
        api: "openai-completions", provider: config.provider, model: config.model,
        stopReason: "stop", timestamp: Date.now(), usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } });
      idle = true;
      await emit("agent_settled");
    } else if (message.command === "disconnect") {
      await emit("session_shutdown", { reason: "reload" });
    } else if (message.command === "stop") {
      await emit("session_shutdown", { reason: "quit" });
      process.send!({ id: message.id, result: { idle, reads, deliveries } }, () => process.exit(0));
      return;
    }
    process.send!({ id: message.id, result: { idle, reads, deliveries } });
  } catch (error) { process.send!({ id: message.id, error: String(error) }); }
});
