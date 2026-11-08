// Opt-in, no-prompt real CLI probe. Isolation flags here are NOT production defaults.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { createRpcAdapterFactory, resolvePiCliPath } from "../src/rpc-client.ts";

const root = await mkdtemp(join(tmpdir(), "pi-subagent-cli-probe-"));
const cwd = join(root, "workspace");
const home = join(root, "home");
await mkdir(cwd);
await mkdir(home);
const adapter = createRpcAdapterFactory((options) => new RpcClient({
  ...options,
  env: {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  },
  args: [...options.args!, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-approve"],
}))({ cwd, provider: "openai", model: "gpt-4o-mini", thinking: "off" });
try {
  await adapter.start();
  const state = await adapter.getState();
  assert.equal(state.model?.provider, "openai");
  assert.equal(state.model?.id, "gpt-4o-mini");
  assert.equal(state.thinkingLevel, "off");
  assert.equal(state.isStreaming, false);
  assert.equal(state.sessionFile, undefined);
  assert.equal(state.messageCount, 0);
  assert.equal(await adapter.getLastAssistantText(), null);
  await adapter.stop();
  await adapter.stop();
  console.log(JSON.stringify({ cliPath: resolvePiCliPath(), model: state.model.id,
    started: true, stopped: true, promptSent: false }));
} finally {
  await adapter.stop();
  await rm(root, { recursive: true, force: true });
}
