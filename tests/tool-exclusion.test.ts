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
import extension from "../index.ts";
import { SUBAGENT_TOOL_NAME } from "../src/config.ts";
import { FakeRpcClient } from "./helpers/fake-rpc-client.ts";

// This is an isolated SDK fixture, not the production extension or a model response.
const offlineModel: NonNullable<ExtensionContext["model"]> = {
  provider: "offline-probe", id: "offline-probe", name: "Offline probe",
  api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false,
  input: ["text"], contextWindow: 4096, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const scenarios = [
  ...(["direct", "codemode", "deferred"] satisfies ToolExposure[]).map((exposure) => ({ exposure, production: false })),
  { exposure: "direct" as const, production: true },
];
for (const { exposure, production } of scenarios) {
  for (const excluded of [false, true]) {
    test(`subagent excluded=${excluded}, exposure=${exposure}, production=${production}: registry and nested execution`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "pi-subagent-exclusion-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      t.mock.method(globalThis, "fetch", () => { throw new Error("Network forbidden in offline test"); });
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false },
      });
      const calls: string[] = [];
      const client = new FakeRpcClient();
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: true,
        // Even excluded tools are really registered by an extension factory.
        extensionFactories: [(pi) => {
          if (production) {
            extension(pi, { createClient() { calls.push("spawn"); return client; } });
          } else pi.registerTool({
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
              const invalid = [];
              if (production && !excluded) {
                for (const partial of [{ provider: "p" }, { model: "m" }]) {
                  invalid.push(await ctx.executeTool(SUBAGENT_TOOL_NAME, {
                    action: "spawn", name: "reviewer", message: "offline task", ...partial,
                  }));
                }
              }
              for (const action of ["spawn", "send"]) {
                const outcome = await ctx.executeTool(SUBAGENT_TOOL_NAME, {
                  action, name: "reviewer", message: "offline task",
                  ...(production && action === "spawn" ? { thinking: "off" } : {}),
                });
                outcomes.push({ action, isError: outcome.isError, content: outcome.result.content });
              }
              return { content: [{ type: "text", text: "probe complete" }], details: { outcomes, invalid } };
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
        invalid: { isError: boolean; result: { content: { type: string; text?: string }[] } }[];
      };
      assert.deepEqual(details.outcomes.map((outcome) => outcome.action), ["spawn", "send"]);
      for (const outcome of details.outcomes) {
        assert.equal(outcome.isError, excluded);
        assert.deepEqual(outcome.content, [{
          type: "text", text: excluded ? `Tool ${SUBAGENT_TOOL_NAME} not found`
            : production ? JSON.stringify({ name: "reviewer", disposition: "started" }) : "stub executed",
        }]);
      }
      assert.deepEqual(calls, excluded ? [] : production ? ["spawn"] : ["spawn", "send"]);
      if (production) {
        assert.equal(details.invalid.length, excluded ? 0 : 2);
        for (const outcome of details.invalid) {
          assert.equal(outcome.isError, true);
          assert.match(outcome.result.content[0].text!, /provider and model must be provided together/);
        }
        assert.deepEqual(client.calls.filter(({ method }) => method === "prompt").map(({ args }) => args),
          excluded ? [] : [["offline task"], ["offline task", undefined, "steer"]]);
      }
    });
  }
}
