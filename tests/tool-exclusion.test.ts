import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolExposure } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAME } from "../src/config.ts";

// This is an isolated SDK fixture, not the production extension or a model response.
const offlineModel: NonNullable<ExtensionContext["model"]> = {
  provider: "offline-probe", id: "offline-probe", name: "Offline probe",
  api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false,
  input: ["text"], contextWindow: 4096, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

for (const exposure of ["direct", "codemode", "deferred"] satisfies ToolExposure[]) {
  for (const excluded of [false, true]) {
    test(`subagent excluded=${excluded}, exposure=${exposure}: registry and nested execution`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "pi-subagent-exclusion-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden in offline test"); });
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false },
      });
      const calls: string[] = [];
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: true,
        // Even excluded tools are really registered by an extension factory.
        extensionFactories: [(pi) => {
          pi.registerTool({
            name: SUBAGENT_TOOL_NAME, label: "Subagent", description: "Offline stub only", exposure,
            parameters: {
              type: "object", required: ["action"],
              properties: { action: { type: "string", enum: ["spawn", "send"] } },
            },
            async execute(_id, args) {
              calls.push(String(args.action));
              return { content: [{ type: "text", text: "stub executed" }], details: {} };
            },
          });
          pi.registerTool({
            name: "probe_caller", label: "Probe caller", description: "Exercise ctx.executeTool",
            parameters: { type: "object", properties: {} },
            async execute(_id, _args, _signal, _onUpdate, ctx) {
              const outcomes = [];
              for (const action of ["spawn", "send"]) {
                const outcome = await ctx.executeTool(SUBAGENT_TOOL_NAME, { action });
                outcomes.push({ action, isError: outcome.isError, content: outcome.result.content });
              }
              return { content: [{ type: "text", text: "probe complete" }], details: { outcomes } };
            },
          });
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(root, "auth.json"), modelsPath: null,
        modelsStorePath: join(root, "model-store.json"),
        allowModelNetwork: false, refreshOnCreate: false,
      });
      const { session } = await createAgentSession({
        cwd: root, agentDir: root, model: offlineModel, modelRuntime,
        resourceLoader: loader, settingsManager,
        sessionManager: SessionManager.inMemory(root), noTools: "builtin",
        excludeTools: excluded ? [SUBAGENT_TOOL_NAME] : [],
      });
      t.after(() => session.dispose());
      // Nested calls require an assistant-issued caller; no model is run to produce it.
      session.agent.state.messages.push({
        role: "assistant", api: offlineModel.api, provider: offlineModel.provider, model: offlineModel.id,
        content: [{ type: "toolCall", id: "offline-probe", name: "probe_caller", arguments: {} }],
        stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      assert.equal(session.getAllTools().some((tool) => tool.name === SUBAGENT_TOOL_NAME), !excluded);
      assert.equal(session.getCallableToolNames().includes(SUBAGENT_TOOL_NAME), !excluded);
      assert.equal(session.getActiveToolNames().includes(SUBAGENT_TOOL_NAME), !excluded && exposure === "direct");
      session.setActiveToolsByName([...session.getActiveToolNames(), SUBAGENT_TOOL_NAME]);
      assert.equal(session.getActiveToolNames().includes(SUBAGENT_TOOL_NAME), !excluded);
      const caller = session.agent.state.tools.find((tool) => tool.name === "probe_caller");
      assert.ok(caller);
      const result = await caller.execute("offline-probe", {}, undefined);
      const details = result.details as {
        outcomes: { action: string; isError: boolean; content: { type: string; text?: string }[] }[];
      };
      assert.deepEqual(details.outcomes.map((outcome) => outcome.action), ["spawn", "send"]);
      for (const outcome of details.outcomes) {
        assert.equal(outcome.isError, excluded);
        assert.deepEqual(outcome.content, [{
          type: "text", text: excluded ? `Tool ${SUBAGENT_TOOL_NAME} not found` : "stub executed",
        }]);
      }
      assert.deepEqual(calls, excluded ? [] : ["spawn", "send"]);
    });
  }
}
