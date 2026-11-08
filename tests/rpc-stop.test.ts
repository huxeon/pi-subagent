import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { createRpcAdapterFactory } from "../src/rpc-client.ts";
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
  test(`official SDK stop is bounded: ${behavior}`, { timeout: 10000 }, async (t) => {
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
      // Only readiness is stubbed. Spawn, signals, exit handling, force kill and stop are official SDK code.
      t.mock.method(client, "getState", async () => new FakeRpcClient().state);
      return client;
    })({ cwd: root, provider: "unused", model: "unused", thinking: "off" });
    t.after(() => adapter.stop());
    await adapter.start();
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
    const first = adapter.stop();
    assert.equal(adapter.stop(), first);
    await first;
    // Generous scheduler tolerance around the SDK's fixed 1000ms fallback.
    assert.ok(performance.now() - start < 3000, "stop must not wait indefinitely for an exit event");
    await waitUntil(() => !alive(pid!));
    await adapter.stop();
  });
}
