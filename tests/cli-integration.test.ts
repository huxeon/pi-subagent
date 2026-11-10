import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { resolvePiCliPath } from "../src/rpc-client.ts";
import type { SubagentInput, SubagentReport } from "../src/types.ts";

type Log = { type: string; pid: number; child: boolean; text?: string; mode?: string;
  users?: string[]; tools?: string[]; registered?: string[]; callable?: string[];
  provider?: string; model?: string; thinking?: string; cwd?: string; sessionFile?: string;
  messageType?: string; reason?: string; content?: string; delivery?: { deliverAs: string; triggerTurn: boolean }; results?: { isError: boolean; result: { content: { text?: string }[] } }[] };

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15000;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await delay(15);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; last value (tail): ${JSON.stringify(value).slice(-8000)}`);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-integration-"));
  const cwd = join(root, "workspace");
  const agent = join(root, "agent");
  const extensions = join(agent, "extensions");
  await mkdir(cwd);
  await mkdir(extensions, { recursive: true });
  await mkdir(join(root, "home"));
  await writeFile(join(root, "events.jsonl"), "");
  // Default global discovery, not -e/no-extensions. The wrapper only records that
  // the actual production factory executed and immediately forwards/logs reports;
  // it does not replace its manager, RpcClient or scheduler.
  await writeFile(join(extensions, "01-production.ts"), `
import extension from ${JSON.stringify(resolve("index.ts"))};
import { appendFileSync } from "node:fs";
export default function(pi) {
  extension(new Proxy(pi, { get(target, key) {
    if (key !== "sendMessage") return Reflect.get(target, key);
    return (message, delivery) => {
      appendFileSync(${JSON.stringify(join(root, "events.jsonl"))}, JSON.stringify({
        type: "delivery", pid: process.pid, child: false, content: message.content, delivery
      }) + "\\n");
      return target.sendMessage(message, delivery);
    };
  } }));
  appendFileSync(${JSON.stringify(join(root, "events.jsonl"))}, JSON.stringify({
    type: "production-loaded", pid: process.pid, child: process.argv.includes("--exclude-tools")
  }) + "\\n");
}
`);
  await copyFile(resolve("tests/fixtures/offline-cli-extension.ts"), join(extensions, "02-fixture.ts"));
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "fixed", defaultThinkingLevel: "low",
    defaultProjectTrust: "never", compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false },
  }));
  // RpcClient merges env with process.env: explicitly REMOVE everything except
  // PATH/locale/system essentials, including credentials, NODE_OPTIONS and PI_*.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  for (const key of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "TMPDIR"]) env[key] = process.env[key];
  Object.assign(env, {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", SUBAGENT_FIXTURE_ROOT: root,
  });
  const client = new RpcClient({ cliPath: resolvePiCliPath(), cwd,
    provider: "fixture", model: "fixed", args: ["--no-session", "--thinking", "low"],
    // SDK's narrow type omits Node spawn's supported undefined (delete) values.
    env: env as Record<string, string> });
  const events: JsonAgentSessionEvent[] = [];
  client.onEvent((event) => { events.push(event); });
  let serial = 0;
  const logs = async (): Promise<Log[]> => (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Log);
  const waitLog = (predicate: (log: Log) => boolean) => eventually(logs, (rows) => rows.some(predicate), "fixture log");
  async function idle() {
    await eventually(() => client.getState(), (s) => !s.isStreaming && s.pendingMessageCount === 0, "parent idle");
  }
  async function call(input: SubagentInput) {
    await idle();
    const id = `call-${++serial}`;
    assert.equal(await client.prompt(`CALL ${JSON.stringify({ id, input })}`), "started");
    const completed = await eventually(() => events.find((e) => e.type === "tool_execution_end" && e.toolCallId === id),
      (e) => e !== undefined, `tool result ${id}`);
    assert.ok(completed?.type === "tool_execution_end");
    await idle();
    return completed;
  }
  const reports = () => events.filter((e) => e.type === "message_end" && e.message.role === "custom" &&
    e.message.customType === "subagent.report").map((e) => {
      assert.ok(e.type === "message_end" && e.message.role === "custom");
      assert.equal(e.message.display, true);
      const details = e.message.details as SubagentReport;
      assert.equal(typeof details?.name, "string");
      assert.equal(e.message.content, `Subagent: ${details.name}\n\n${details.text ?? "(No assistant text available.)"}`);
      return String(e.message.content);
    });
  const waitReport = (name: string, includes: string) => eventually(reports,
    (items) => items.some((text) => text.startsWith(`Subagent: ${name}\n\n`) && text.includes(includes)), `report ${name}: ${includes}`);
  async function stoppedChildren(pids: number[]) {
    await eventually(() => pids.filter(alive), (live) => live.length === 0, "child PID cleanup");
  }
  async function cleanup() {
    try {
      await client.stop();
      const rows = await logs();
      const pids = [...new Set(rows.map((r) => r.pid))];
      await stoppedChildren(pids);
      assert.equal((await logs()).some((r) => r.type === "network-attempt"), false);
    } finally {
      // Emergency cleanup on assertion failure; never leave a controlled CLI behind.
      for (const pid of new Set((await logs()).map((r) => r.pid))) {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  }
  return { root, cwd, client, events, logs, waitLog, idle, call, reports, waitReport, stoppedChildren, cleanup,
    release: (name: string) => writeFile(join(root, `release-${name}`), "ok"),
    async start() { await client.start(); await client.getState(); await waitLog((r) => !r.child && r.type === "ready"); } };
}

test("offline real parent/child CLI: production tools, RPC work, queues, reports, exclusion and runtime shutdown", { timeout: 90000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  await f.start();
  const spawn = (name: string, message: string, config: Partial<SubagentInput> = {}) =>
    f.call({ action: "spawn", name, message, ...config } as SubagentInput);
  const send = (name: string, message: string, followUp?: boolean) => f.call({ action: "send", name, message, ...(followUp !== undefined ? { followUp } : {}) });

  const first = await spawn("alpha", "hold:alpha");
  assert.equal(first.isError, false);
  assert.deepEqual(first.result.details, { name: "alpha", disposition: "started",
    config: { provider: "fixture", model: "fixed", thinking: "low" } });
  assert.equal(first.result.content[0].text, JSON.stringify({ name: "alpha", disposition: "started" }));
  await f.waitLog((r) => r.child && r.type === "request" && r.users?.includes("hold:alpha") === true);
  assert.deepEqual(f.reports(), [], "acceptance must precede child completion");
  const initial = (await f.logs()).find((r) => r.child && r.type === "ready")!;
  const alpha = initial.pid;
  assert.deepEqual({ cwd: initial.cwd, provider: initial.provider, model: initial.model, thinking: initial.thinking },
    { cwd: f.cwd, provider: "fixture", model: "fixed", thinking: "low" });
  assert.equal(initial.sessionFile, undefined);
  assert.equal(initial.tools?.includes("subagent"), false);
  assert.equal((await f.logs()).some((r) => r.pid === alpha && r.type === "production-loaded"), true);

  const duplicate = await spawn("alpha", "duplicate");
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate.result.content), /already exists/);
  assert.equal((await f.logs()).filter((r) => r.child && r.type === "factory").length, 1);
  const steer = await send("alpha", "steering-message");
  const follow = await send("alpha", "follow-up-message", true);
  assert.deepEqual(steer.result.details, { name: "alpha", disposition: "queued" });
  assert.deepEqual(follow.result.details, { name: "alpha", disposition: "queued" });
  const inputs = (await f.logs()).filter((r) => r.pid === alpha && r.type === "input");
  assert.ok(inputs.some((r) => r.text === "steering-message" && r.mode === "steer"));
  assert.ok(inputs.some((r) => r.text === "follow-up-message" && r.mode === "followUp"));

  // A distinct name really works concurrently; thinking alone inherits the pair.
  assert.equal((await spawn("beta", "hold:beta", { thinking: "high" })).isError, false);
  await f.waitLog((r) => r.child && r.type === "request" && r.users?.includes("hold:beta") === true);
  const betaReady = (await f.logs()).find((r) => r.child && r.type === "ready" && r.pid !== alpha)!;
  assert.equal(betaReady.thinking, "high");
  assert.equal(betaReady.provider, "fixture");
  assert.equal(betaReady.model, "fixed");
  assert.equal(alive(alpha), true);
  assert.equal(alive(betaReady.pid), true);
  await f.release("beta");
  await f.waitReport("beta", "hold:beta");
  assert.deepEqual(f.reports(), ['Subagent: beta\n\nfixed:["hold:beta"]']);
  assert.equal(f.reports().some((s) => s.startsWith("Subagent: alpha\n")), false);
  await f.release("alpha");
  await f.waitReport("alpha", "follow-up-message");
  const alphaRequests = (await f.logs()).filter((r) => r.pid === alpha && r.type === "request");
  assert.deepEqual(alphaRequests.map((r) => r.users), [
    ["hold:alpha"], ["hold:alpha", "steering-message"], ["hold:alpha", "steering-message", "follow-up-message"],
  ], "real steering is consumed before follow-up, across separate provider requests");
  assert.deepEqual(f.reports().filter((s) => s.startsWith("Subagent: alpha\n")),
    ['Subagent: alpha\n\nfixed:["hold:alpha","steering-message","follow-up-message"]']);
  await f.waitLog((r) => !r.child && r.type === "run" && r.messageType === "custom");
  await f.waitLog((r) => !r.child && r.type === "request" && r.users?.some((s) => s.includes("Subagent: alpha\n")) === true);

  assert.deepEqual((await send("alpha", "second-task")).result.details, { name: "alpha", disposition: "started" });
  await f.waitReport("alpha", "second-task");
  assert.equal(alive(alpha), true, "settled retains process and conversation");
  assert.equal((await f.logs()).filter((r) => r.child && r.type === "factory").length, 2);

  // Parent config changes only affect later spawns. Override pair, inherit thinking.
  await f.idle();
  await f.client.setThinkingLevel("medium");
  assert.equal((await spawn("gamma", "hold:gamma", { provider: "fixture-other", model: "alternate" })).isError, false);
  await f.waitLog((r) => r.child && r.type === "request" && r.provider === "fixture-other");
  const gamma = (await f.logs()).find((r) => r.child && r.type === "ready" && r.provider === "fixture-other")!;
  assert.equal(gamma.model, "alternate");
  assert.equal(gamma.thinking, "medium");
  assert.equal((await send("alpha", "fixture-handled")).result.details.disposition, "handled");
  const reportsBeforeHandled = f.reports().length;
  await f.idle();
  assert.equal(f.reports().length, reportsBeforeHandled);

  // Real compaction preflight rejection, not a fake SDK error.
  assert.equal((await send("alpha", "/fixture-compact")).result.details.disposition, "handled");
  await f.waitLog((r) => r.pid === alpha && r.type === "compacting");
  const rejected = await send("alpha", "must-not-retry");
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.result.content), /compaction is in progress/);
  await f.release("compact");

  // Model-issued helper really attempts nested spawn AND send after reactivation.
  assert.equal((await send("beta", "probe-exclusion")).isError, false);
  await f.waitLog((r) => r.pid === betaReady.pid && r.type === "exclusion");
  await f.waitReport("beta", "probe-exclusion");
  const exclusion = (await f.logs()).find((r) => r.pid === betaReady.pid && r.type === "exclusion")!;
  assert.equal(exclusion.registered?.includes("subagent"), false);
  assert.equal(exclusion.callable?.includes("subagent"), false);
  assert.equal(exclusion.results?.length, 2);
  for (const result of exclusion.results!) {
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.result.content), /Tool subagent not found/);
  }
  const rows = await f.logs();
  assert.equal(rows.some((r) => r.type === "request" && r.tools?.includes("subagent") && r.child), false);
  assert.equal(rows.filter((r) => r.pid === alpha && r.text === "must-not-retry").length, 0);
  assert.equal(rows.filter((r) => r.child && r.type === "factory").length, 3);

  // Reports steer an already-busy parent rather than waiting for another user turn.
  await f.idle();
  assert.equal(await f.client.prompt("hold:parent"), "started");
  await f.waitLog((r) => !r.child && r.type === "request" && r.users?.at(-1) === "hold:parent");
  await f.release("gamma");
  await f.waitLog((r) => r.pid === gamma.pid && r.type === "settled");
  const delivered = await f.waitLog((r) => r.type === "delivery" && r.content?.startsWith("Subagent: gamma\n") === true);
  assert.deepEqual(delivered.find((r) => r.type === "delivery" && r.content?.startsWith("Subagent: gamma\n"))?.delivery,
    { deliverAs: "steer", triggerTurn: true });
  assert.equal(f.reports().some((s) => s.startsWith("Subagent: gamma\n")), false,
    "busy parent must consume the custom message at its next turn boundary");
  await f.release("parent");
  await f.waitReport("gamma", "hold:gamma");
  await f.waitLog((r) => !r.child && r.type === "request" && r.users?.at(-1)?.includes("Subagent: gamma") === true);
  await f.idle();

  // Shutdown through actual session replacement: idle and working children together.
  assert.equal((await send("alpha", "hold:shutdown-work")).isError, false);
  const beforeShutdown = await f.waitLog((r) => r.pid === alpha && r.type === "request" && r.users?.at(-1) === "hold:shutdown-work");
  assert.equal(beforeShutdown.find((r) => r.pid === alpha && r.type === "request" &&
    r.users?.at(-1) === "hold:shutdown-work")?.provider, "fixture");
  assert.equal(beforeShutdown.some((r) => r.pid === alpha && r.type === "request" &&
    r.users?.includes("must-not-retry")), false);
  const reportCount = f.reports().length;
  assert.deepEqual(await f.client.newSession(), { cancelled: false });
  await f.stoppedChildren([alpha, betaReady.pid, gamma.pid]);
  await f.release("shutdown-work");
  const unknown = await send("alpha", "old-name");
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown.result.content), /Unknown subagent/);
  assert.equal(f.reports().length, reportCount, "no late report after replacement");
  assert.equal((await spawn("alpha", "hold:reused")).isError, false);
  await f.waitLog((r) => r.child && r.type === "request" && r.users?.at(-1) === "hold:reused");
  const finalRows = await f.logs();
  assert.ok(finalRows.some((r) => !r.child && r.type === "shutdown" && r.reason === "new"));
  assert.equal(finalRows.some((r) => r.type === "network-attempt"), false);
});

test("offline real CLI: parent shutdown also stops a child still loading its extension factory", { timeout: 45000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.cleanup());
  await f.start();
  await writeFile(join(f.root, "pause-start"), "yes");
  assert.equal(await f.client.prompt(`CALL ${JSON.stringify({ id: "starting-call", input: {
    action: "spawn", name: "starting", message: "must-not-run",
  } })}`), "started");
  const rows = await f.waitLog((r) => r.child && r.type === "starting");
  const child = rows.find((r) => r.child && r.type === "starting")!;
  assert.ok(rows.some((r) => r.pid === child.pid && r.type === "production-loaded"));
  const began = Date.now();
  await f.client.stop();
  await f.stoppedChildren([child.pid]);
  assert.ok(Date.now() - began < 5000, "shutdown must not wait for getState's 30-second RPC deadline");
  await f.release("start");
  const after = await f.logs();
  assert.ok(after.some((r) => !r.child && r.type === "shutdown" && r.reason === "quit"),
    "the parent's actual session_shutdown handler completed before exit");
  assert.equal(after.some((r) => r.child && (r.type === "request" || r.type === "settled")), false);
});
