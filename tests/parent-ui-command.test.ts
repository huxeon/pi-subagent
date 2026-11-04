import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";
import { registerParentLifecycle } from "../src/parent-lifecycle.ts";
import { registerParentUi } from "../src/parent-ui.ts";
import type { ParentManager } from "../src/parent-manager.ts";
import type { UiEntry, UiClock } from "../src/ui-refresh.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
test("parent command uses existing snapshot, direct revalidation and switch-client; dialog disposes, lifecycle cleans first", async () => {
  const previous = process.env.TMUX;
  process.env.TMUX = "/fake-test-server,123,0";
  try {
    let timer: (() => void) | undefined;
    const clock: UiClock = { setInterval(callback) { timer = callback; return callback; }, clearInterval() { timer = undefined; } };
    const events = new Map<string, Array<(...args: any[]) => any>>();
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    let listCalls = 0, statusCalls = 0, switches = 0;
    let offline = false, statusFails = false;
    let lastWidget: unknown;
    const notifications: string[] = [];
    const manager = {
      options: { agentDir: "/tmp/ui-test-not-created", parentSessionId: "parent" },
      async recover() { return []; },
      async list(): Promise<UiEntry[]> { listCalls++; return [{ name: "中文", status: offline ? { available: false, reason: "unavailable" } : { available: true, workState: "working" } }]; },
      async status(name: string, options: { timeoutMs: number }) {
        assert.equal(name, "中文"); assert.equal(options.timeoutMs, 600);
        statusCalls++; if (statusFails) throw new Error("gone before enter"); return { state: "idle" };
      },
      async shutdown(reason: string) { assert.equal(reason, "reload"); assert.equal(timer, undefined); assert.equal(lastWidget, undefined); },
    } as unknown as ParentManager;
    const pi = {
      on(name: string, handler: (...args: any[]) => any) { events.set(name, [...events.get(name) ?? [], handler]); },
      registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
      async exec(binary: string, args: string[]) {
        assert.equal(binary, "tmux"); assert.equal(args[0], "switch-client"); assert.match(args[2]!, /^=pi-subagent-[0-9a-f]{32}$/);
        switches++; return { code: 0, killed: false, stdout: "", stderr: "" };
      },
    } as unknown as ExtensionAPI;
    const lifecycle = registerParentLifecycle(pi, () => manager);
    registerParentUi(pi, lifecycle, clock);
    let action = "\r";
    const ctx = {
      mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => "parent" },
      ui: {
        setWidget(_key: string, value: unknown) { lastWidget = value; },
        notify(text: string) { notifications.push(text); },
        custom(factory: Function) {
          return new Promise(resolve => {
            let component: Component & { dispose?(): void };
            component = factory({ requestRender() {} }, theme, new KeybindingsManager(TUI_KEYBINDINGS), (value: unknown) => { component.dispose?.(); resolve(value); });
            queueMicrotask(() => component.handleInput?.(action));
          });
        },
      },
    } as unknown as ExtensionCommandContext;
    for (const handler of events.get("session_start")!) await handler({}, ctx);
    await Promise.resolve(); await Promise.resolve();
    await command("", ctx);
    assert.equal(listCalls, 1); assert.equal(statusCalls, 1); assert.equal(switches, 1);
    statusFails = true; await command("", ctx);
    assert.equal(switches, 1); assert.match(notifications.at(-1)!, /gone before enter/);
    // Confirming an unavailable row keeps the picker open. Then cancel via a
    // configured cancellation key rather than accidentally entering that row.
    offline = true; timer!(); await Promise.resolve(); await Promise.resolve();
    action = "\x1b"; await command("", ctx); assert.equal(statusCalls, 2);
    action = "";
    const pendingCommand = command("", ctx); // Leave a live picker open during reload.
    await Promise.resolve(); await Promise.resolve();
    for (const handler of events.get("session_shutdown")!) await handler({ reason: "reload" }, ctx as ExtensionContext);
    await pendingCommand;
    assert.equal(timer, undefined);
  } finally {
    if (previous === undefined) delete process.env.TMUX; else process.env.TMUX = previous;
  }
});
