import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// Actual Pi/jiti root-entry loading, not a model run or default-resource CLI probe.
test("Pi loads the stable root entry without starting a session or background resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-extension-load-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden in offline test"); });
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [entry],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const [extension] = loaded.extensions;
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()], ["subagent"]);
  assert.equal(extension.tools.get("subagent")!.definition.name, "subagent");
  assert.equal(typeof extension.tools.get("subagent")!.definition.renderCall, "function");
  assert.equal(typeof extension.tools.get("subagent")!.definition.renderResult, "function");
  assert.deepEqual([...extension.messageRenderers.keys()], ["subagent.report"]);
  assert.deepEqual([...extension.handlers.keys()], ["session_start", "session_shutdown"]);
  assert.equal(extension.handlers.get("session_start")!.length, 1);
  assert.equal(extension.handlers.get("session_shutdown")!.length, 1);
});
