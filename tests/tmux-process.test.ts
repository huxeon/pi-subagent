import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ParentManager } from "../src/parent-manager.ts";
import { getSubagentPaths } from "../src/paths.ts";
import { TmuxProcessDriver, tmuxSessionName } from "../src/process-driver.ts";
import { prepareSocketAddress } from "../src/socket-path.ts";
const exec = promisify(execFile);

test("controlled tmux: direct argv/env, runtime process discovery, reconnect, SIGTERM awaited, session-only restore and stop", async t => {
  try { await exec("tmux", ["-V"]); } catch { t.skip("tmux unavailable"); return; }
  if (process.platform !== "linux") { t.skip("Linux /proc required"); return; }
  const root = await mkdtemp(join(tmpdir(), "pi-tmux-"));
  const xdg = join(root, "xdg"); await mkdir(xdg, { mode: 0o700 });
  const cwd = join(root, "space ' ; $(false)"); await mkdir(cwd);
  const socket = join(root, "tmux");
  const proof = join(root, "stopped");
  const executable = fileURLToPath(new URL("./fixtures/managed-child.mjs", import.meta.url));
  await chmod(executable, 0o700);
  const driver = new TmuxProcessDriver({ tmuxArgs: ["-S", socket, "-f", "/dev/null"], executable,
    entry: fileURLToPath(new URL("../index.ts", import.meta.url)), env: { ...process.env, XDG_RUNTIME_DIR: xdg, PI_TEST_STOP_PROOF: proof } });
  const options = { agentDir: root, parentSessionId: "test-parent", driver, readyTimeoutMs: 5000,
    transport: { address: { xdgRuntimeDir: xdg } } };
  const manager = new ParentManager(options);
  const paths = getSubagentPaths(root, "test-parent", "测试 ; $() '");
  t.after(async () => {
    await driver.stop(paths).catch(() => {});
    // Dedicated -S server created by this test only; never default user tmux.
    await exec("tmux", ["-S", socket, "kill-server"]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await manager.spawn({ operation: "spawn", name: paths.name, prompt: "offline only" }, { cwd, provider: "test", model: "no-model", thinking: "high" });
  assert.equal(await driver.isRunning(paths), true);
  const record = await readFile(paths.sessionFile, "utf8");
  const listing = await exec("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"]);
  assert.equal(listing.stdout.trim(), tmuxSessionName(paths.runDir));
  await manager.shutdown("reload");
  assert.equal(await driver.isRunning(paths), true);
  const reconnected = new ParentManager(options);
  assert.deepEqual(await reconnected.recover(), [{ name: paths.name, connected: true }]);
  await reconnected.shutdown("quit");
  assert.equal(await readFile(proof, "utf8"), "async shutdown completed");
  assert.equal(await driver.isRunning(paths), false);
  const { socketPath } = await prepareSocketAddress(paths.runDir, options.transport.address);
  await assert.rejects(readFile(socketPath), { code: "ENOENT" });
  assert.equal(await readFile(paths.sessionFile, "utf8"), record);
  const resumed = new ParentManager(options);
  assert.deepEqual(await resumed.recover(), [{ name: paths.name, connected: true }]);
  assert.equal(await readFile(paths.sessionFile, "utf8"), record); // No old task replay.
  await resumed.stop(paths.name); await resumed.stop(paths.name);
  assert.equal(await driver.isRunning(paths), false);
  await assert.rejects(readFile(paths.sessionFile), { code: "ENOENT" });
  await resumed.shutdown("quit");
  const foreign = getSubagentPaths(root, "test-parent", "collision");
  const foreignName = tmuxSessionName(foreign.runDir);
  await exec("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", foreignName,
    "-e", "PI_SUBAGENT_RUN_DIR=/not-this-child", "--", process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  await assert.rejects(driver.start(foreign), /Foreign tmux session/);
  await assert.rejects(driver.stop(foreign), /Foreign tmux session/);
  await exec("tmux", ["-S", socket, "has-session", "-t", `=${foreignName}`]);
  // Only the test that created this intentionally foreign resource removes it.
  await exec("tmux", ["-S", socket, "kill-session", "-t", `=${foreignName}`]);
});
