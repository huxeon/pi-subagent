import type { JsonAgentSessionEvent, RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { PromptDisposition, RpcAdapter } from "../../src/types.ts";

/** Offline SDK-boundary fake; also usable as a manager's injected RpcAdapter. */
export class FakeRpcClient implements RpcAdapter {
  calls: { method: string; args: unknown[] }[] = [];
  listeners = new Set<RpcEventListener>();
  disposition: PromptDisposition = "started";
  text: string | null = null;
  state: RpcSessionState = {
    thinkingLevel: "off", isStreaming: false, isCompacting: false,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
    sessionId: "fake-session", autoCompactionEnabled: true,
    messageCount: 0, pendingMessageCount: 0,
  };

  async start(): Promise<void> { this.calls.push({ method: "start", args: [] }); }
  async stop(): Promise<void> { this.calls.push({ method: "stop", args: [] }); }
  async getState(): Promise<RpcSessionState> {
    this.calls.push({ method: "getState", args: [] });
    return this.state;
  }
  async prompt(...args: Parameters<RpcAdapter["prompt"]>): Promise<PromptDisposition> {
    this.calls.push({ method: "prompt", args });
    return this.disposition;
  }
  onEvent(listener: RpcEventListener): () => void {
    this.calls.push({ method: "onEvent", args: [listener] });
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: JsonAgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  async getLastAssistantText(): Promise<string | null> {
    this.calls.push({ method: "getLastAssistantText", args: [] });
    return this.text;
  }
}
