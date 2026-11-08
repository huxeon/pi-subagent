import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { createRpcAdapterFactory } from "../src/rpc-client.ts";
import { SubagentManager } from "../src/manager.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Process fixture deadline exceeded");
    await delay(10);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

for (const behavior of ["normal", "ignore-term", "already-exited"] as const) {
  test(`manager shutdown through official SDK stop is bounded: ${behavior}`, { timeout: 10000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-stop-"));
    const readyFile = join(root, "ready");
    const exitFile = join(root, "exit");
    let pid: number | undefined;
    t.after(async () => {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    });
    const adapter = createRpcAdapterFactory((options) => {
      const client = new RpcClient({
        ...options,
        cliPath: fileURLToPath(new URL("./fixtures/rpc-stop-child.mjs", import.meta.url)),
        env: {
          PI_TEST_READY_FILE: readyFile, PI_TEST_EXIT_FILE: exitFile,
          PI_TEST_IGNORE_TERM: behavior === "ignore-term" ? "1" : "0",
        },
      });
      // Only readiness/acceptance are stubbed: no RPC protocol or model calls.
      // Spawn, signals, exit handling, force kill and stop are official SDK code.
      t.mock.method(client, "getState", async () => new FakeRpcClient().state);
      t.mock.method(client, "prompt", async () => "started" as const);
      return client;
    })({ cwd: root, provider: "unused", model: "unused", thinking: "off" });
    const manager = new SubagentManager({
      createClient: () => adapter,
      sendMessage() { assert.fail("The process fixture emits no settled event"); },
    });
    t.after(() => manager.shutdown());
    await manager.spawn({
      action: "spawn", name: "controlled-child", message: "not sent to a model",
      provider: "unused", model: "unused", thinking: "off",
    }, { cwd: root });
    await waitUntil(async () => {
      try { pid = Number(await readFile(readyFile, "utf8")); return !!pid; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    if (behavior === "already-exited") {
      await writeFile(exitFile, "exit");
      await waitUntil(() => !alive(pid!));
    }
    const start = performance.now();
    const first = manager.shutdown();
    assert.equal(manager.shutdown(), first);
    await first;
    // Generous scheduler tolerance around the SDK's fixed 1000ms fallback.
    assert.ok(performance.now() - start < 3000, "stop must not wait indefinitely for an exit event");
    await waitUntil(() => !alive(pid!));
    assert.equal(manager.shutdown(), first);
    await adapter.stop(); // Manager teardown and a later direct stop still coalesce safely.
  });
}
