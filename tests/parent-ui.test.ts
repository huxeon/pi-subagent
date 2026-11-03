import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { UiRefresh, type UiClock, type UiEntry } from "../src/ui-refresh.ts";
import { renderWidget, SubagentPicker } from "../src/ui-components.ts";
import { attachTerminal, registerParentUi } from "../src/parent-ui.ts";
import { ParentManager } from "../src/parent-manager.ts";
import { createSubagentDirectory } from "../src/paths.ts";
import { registerParentLifecycle } from "../src/parent-lifecycle.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const entry = (name: string, working = false): UiEntry => ({ name, status: { available: true, workState: working ? "working" : "idle" } });
const offline = (name: string): UiEntry => ({ name, status: { available: false, reason: "unavailable" } });
class Clock implements UiClock {
  timers = new Set<() => void>();
  setInterval(callback: () => void, ms: number) { assert.equal(ms, 1000); this.timers.add(callback); return callback; }
  clearInterval(timer: unknown) { this.timers.delete(timer as () => void); }
  tick() { for (const callback of this.timers) callback(); }
}

test("one refresher, shared snapshot, non-reentry, immediate start and no late updates after stop", async () => {
  const clock = new Clock();
  let calls = 0;
  let finish!: (entries: UiEntry[]) => void;
  let signal!: AbortSignal;
  const refresh = new UiRefresh({ list(options) {
    calls++; signal = options.signal!; assert.equal(options.timeoutMs, 600);
    return new Promise(resolve => { finish = resolve; });
  } }, clock);
  let widget: readonly UiEntry[] = [], picker: readonly UiEntry[] = [];
  refresh.subscribe(() => { widget = refresh.snapshot; });
  const unsubscribe = refresh.subscribe(() => { picker = refresh.snapshot; });
  refresh.start(); refresh.start(); clock.tick(); clock.tick();
  assert.equal(clock.timers.size, 1); assert.equal(calls, 1);
  finish([entry("中文")]); await refresh.settled();
  assert.equal(widget, picker); assert.equal(widget, refresh.snapshot);
  unsubscribe(); clock.tick(); assert.equal(calls, 2);
  refresh.stop(); refresh.stop(); assert.equal(clock.timers.size, 0); assert.equal(signal.aborted, true);
  finish([entry("old context")]); await refresh.settled(); clock.tick();
  assert.deepEqual(refresh.snapshot, []); assert.equal(calls, 2); assert.equal(widget[0]?.name, "中文");
});

test("create/destroy/recover lists replace snapshots; global errors never preserve available state", async () => {
  let entries = [entry("a")]; let error = false;
  const refresh = new UiRefresh({ async list() { if (error) throw new Error("scan failed"); return entries; } }, new Clock());
  await refresh.refresh(); entries = [entry("a", true), offline("b")]; await refresh.refresh();
  assert.deepEqual(refresh.snapshot, entries);
  entries = [entry("b")]; await refresh.refresh(); assert.equal(refresh.snapshot[0]?.name, "b");
  error = true; await refresh.refresh(); assert.equal(refresh.snapshot[0]?.status.available, false);
  assert.match(refresh.error!, /scan failed/);
  error = false; entries = []; await refresh.refresh(); assert.deepEqual(refresh.snapshot, []);
  refresh.stop();
});

test("stable selection on reorder, status update, removal and unavailable confirmation; injected keys and cancel", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.up": "k" });
  const choices: Array<string | undefined> = [];
  const picker = new SubagentPicker(theme, keys, name => choices.push(name), () => {});
  picker.update([entry("a"), entry("中文")]); picker.handleInput("j");
  assert.equal(picker.selectedName, "中文");
  picker.update([entry("中文", true), entry("new"), entry("a")]);
  assert.equal(picker.selectedName, "中文");
  picker.update([entry("new"), entry("a")]); picker.handleInput("\r");
  assert.deepEqual(choices, []); // Removed item remains a disabled tombstone.
  picker.handleInput("k"); assert.equal(picker.selectedName, "a");
  picker.update([entry("new"), offline("a")]); picker.handleInput("\r"); assert.deepEqual(choices, []);
  picker.update([entry("a"), entry("new")]); picker.handleInput("\r"); assert.deepEqual(choices, ["a"]);
  picker.handleInput("\x1b"); assert.deepEqual(choices, ["a", undefined]);
});

test("widget hidden at zero, capped at five, width-safe Chinese/emoji/long names and picker", () => {
  const entries = Array.from({ length: 12 }, (_, i) => i === 4 ? offline("不可用") : entry(`中文长名称😀-${i}`.repeat(3), i % 2 === 0));
  assert.deepEqual(renderWidget([], 80, theme), []);
  const wide = renderWidget(entries, 300, theme).join(""); assert.match(wide, /\+7 more/); assert.match(wide, /unavailable/);
  const picker = new SubagentPicker(theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {}, () => {}); picker.update(entries);
  assert.match(picker.render(40).join("\n"), /:working/);
  assert.match(picker.render(40).join("\n"), /:unavailable/);
  for (const width of [0, 1, 2, 7, 20, 40, 80, 300]) {
    for (const line of [...renderWidget(entries, width, theme), ...picker.render(width)]) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  assert.equal(renderWidget([entry("\x1b[31mname\x1b[0m")], 80, theme).join("").includes("\x1b"), false);
});

test("terminal detach/exception/spawn failure always restores TUI", () => {
  for (const fails of [false, true]) {
    const calls: string[] = [];
    const tui = { stop() { calls.push("stop"); }, start() { calls.push("start"); }, requestRender(full?: boolean) { assert.equal(full, true); calls.push("render"); } };
    const run = (target: string) => { assert.equal(target, "=safe"); calls.push("attach"); if (fails) throw new Error("spawn/attach failed"); };
    if (fails) assert.throws(() => attachTerminal(tui, "=safe", run), /failed/);
    else attachTerminal(tui, "=safe", run);
    assert.deepEqual(calls, ["stop", "attach", "start", "render"]);
  }
});

test("non TUI (including RPC hasUI) starts no polling, accesses no UI or terminal", async () => {
  for (const mode of ["rpc", "json", "print"]) {
    const clock = new Clock(); const events = new Map<string, Function>(); let command: Function | undefined;
    const pi = { on: (name: string, handler: Function) => events.set(name, handler), registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; } } as unknown as ExtensionAPI;
    const lifecycle = { current() { throw new Error("manager accessed"); }, onStopping() { throw new Error("cleanup registered"); } } as unknown as ReturnType<typeof registerParentLifecycle>;
    registerParentUi(pi, lifecycle, clock);
    const ctx = { mode, hasUI: mode === "rpc", get ui() { throw new Error("UI accessed"); } };
    await events.get("session_start")!({}, ctx); clock.tick(); await command!("", ctx);
    assert.equal(clock.timers.size, 0);
  }
});

test("real manager deadlines with fake connections isolate a hung peer; reload closes UI and shared connections", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-ui-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["fast", "hung"]) await createSubagentDirectory(root, "parent", name);
  const closed: string[] = []; const methods: string[] = [];
  const manager = new ParentManager({ agentDir: root, parentSessionId: "parent",
    driver: { start: async () => {}, stop: async () => { throw new Error("reload must not stop"); }, isRunning: async () => false },
    connect: async runDir => ({ async request(method, _params, options) {
      methods.push(method);
      if (method === "identity") return { runDir, sessionFile: join(runDir, "session.jsonl"), pid: 1234, cwd: root };
      if (runDir.endsWith("n-68756e67")) return new Promise((_resolve, reject) => {
        const cancel = () => reject(new Error("deadline"));
        if (options?.signal?.aborted) cancel(); else options?.signal?.addEventListener("abort", cancel, { once: true });
      });
      return { state: "working" };
    }, async close() { closed.push(runDir); } }),
  });
  const refresh = new UiRefresh(manager, new Clock());
  const keepAlive = setInterval(() => {}, 2000); t.after(() => clearInterval(keepAlive));
  const start = Date.now(); await refresh.refresh();
  assert.ok(Date.now() - start < 1800);
  assert.equal(refresh.snapshot.find(e => e.name === "fast")?.status.available, true);
  assert.equal(refresh.snapshot.find(e => e.name === "hung")?.status.available, false);
  assert.equal(methods.includes("message"), false);
  refresh.stop(); await manager.shutdown("reload"); assert.equal(closed.length, 2);
});

test("lifecycle stopping hooks remove widget and poller before manager shutdown; replacement context is independent", async () => {
  const clock = new Clock(); const events = new Map<string, Function[]>(); const cleanups: Array<() => void> = [];
  let queries = 0; const widgets: unknown[] = [];
  const manager = { async list() { queries++; return [entry("a")]; } };
  const pi = { on(name: string, handler: Function) { events.set(name, [...events.get(name) ?? [], handler]); }, registerCommand() {} } as unknown as ExtensionAPI;
  const lifecycle = { current: () => manager, onStopping: (cleanup: () => void) => cleanups.push(cleanup) } as unknown as ReturnType<typeof registerParentLifecycle>;
  registerParentUi(pi, lifecycle, clock);
  const ctx = { mode: "tui", ui: { setWidget: (...args: unknown[]) => widgets.push(args) } } as unknown as ExtensionContext;
  await events.get("session_start")![0]!({}, ctx); await Promise.resolve(); await Promise.resolve();
  assert.equal(clock.timers.size, 1); assert.equal(queries, 1);
  cleanups[0]!(); clock.tick(); assert.equal(clock.timers.size, 0); assert.equal(queries, 1);
  assert.deepEqual(widgets.at(-1), ["subagents", undefined]);
  await events.get("session_start")![0]!({}, ctx); assert.equal(clock.timers.size, 1);
  cleanups.at(-1)!(); assert.equal(clock.timers.size, 0);
});
