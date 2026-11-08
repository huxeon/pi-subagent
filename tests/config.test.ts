import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubagentInput, resolveChildConfig, THINKING_LEVELS } from "../src/config.ts";
import type { ParentConfigSnapshot, SpawnInput } from "../src/types.ts";

const spawn: SpawnInput = { action: "spawn", name: "Reviewer", message: "Review this code" };
const parent: ParentConfigSnapshot = {
  cwd: "/workspace",
  model: { provider: "parent-provider", id: "parent-model" },
  thinkingLevel: "medium",
};
const explicit = { provider: "child-provider", model: "child-model" };

test("provider/model pair and independent thinking inheritance", async (t) => {
  for (const pair of [undefined, explicit]) {
    for (const thinking of [undefined, "high"] as const) {
      await t.test(`pair=${pair ? "explicit" : "inherited"}, thinking=${thinking ?? "inherited"}`, () => {
        const input = { ...spawn, ...pair, ...(thinking === undefined ? {} : { thinking }) };
        assert.deepEqual(resolveChildConfig(input, parent), {
          cwd: parent.cwd,
          provider: pair?.provider ?? parent.model!.provider,
          model: pair?.model ?? parent.model!.id,
          thinking: thinking ?? parent.thinkingLevel,
        });
      });
    }
  }
});

test("provider/model must be supplied together, even if the parent has the other value", () => {
  for (const partial of [{ provider: "p" }, { model: "m" }]) {
    assert.throws(() => parseSubagentInput({ ...spawn, ...partial }), /provided together/);
    assert.throws(() => resolveChildConfig({ ...spawn, ...partial }, parent), /provided together/);
  }
});

test("fully explicit config never reads missing parent model/thinking", () => {
  const config = resolveChildConfig({ ...spawn, ...explicit, thinking: "max" }, {
    cwd: "/workspace",
    get model(): never { throw new Error("must not read parent model"); },
    get thinkingLevel(): never { throw new Error("must not read parent thinking"); },
  });
  assert.deepEqual(config, { cwd: "/workspace", ...explicit, thinking: "max" });
  assert.deepEqual(resolveChildConfig({ ...spawn, ...explicit, thinking: "off" }, { cwd: "/tmp" }), {
    cwd: "/tmp", ...explicit, thinking: "off",
  });
});

test("inherit only the missing configuration, independently", () => {
  assert.deepEqual(resolveChildConfig({ ...spawn, ...explicit }, { cwd: "/tmp", thinkingLevel: "low" }), {
    cwd: "/tmp", ...explicit, thinking: "low",
  });
  assert.equal(resolveChildConfig({ ...spawn, thinking: "high" }, { cwd: "/tmp", model: parent.model }).thinking, "high");
});

test("missing required inherited values fail rather than defaulting", () => {
  const cases: [ParentConfigSnapshot, RegExp][] = [
    [{ cwd: "/tmp", thinkingLevel: "off" }, /parent model provider/],
    [{ cwd: "/tmp", model: { id: "m" }, thinkingLevel: "off" }, /parent model provider/],
    [{ cwd: "/tmp", model: { provider: "p" }, thinkingLevel: "off" }, /parent model id/],
    [{ cwd: "/tmp", model: { provider: "", id: "m" }, thinkingLevel: "off" }, /parent model provider/],
    [{ cwd: "/tmp", model: { provider: "p", id: " " }, thinkingLevel: "off" }, /parent model id/],
    [{ cwd: "/tmp", model: parent.model }, /parent thinkingLevel/],
  ];
  for (const [snapshot, error] of cases) {
    assert.throws(() => resolveChildConfig(spawn, snapshot), error);
  }
  assert.throws(() => resolveChildConfig({ ...spawn, ...explicit }, { cwd: "/tmp" }), /parent thinkingLevel/);
  assert.throws(() => resolveChildConfig({ ...spawn, ...explicit, thinking: "off" }, { cwd: " " }), /parent cwd/);
});

test("all host thinking levels accepted without model lookup or clamping", () => {
  for (const thinking of THINKING_LEVELS) {
    assert.equal(resolveChildConfig({ ...spawn, ...explicit, thinking }, { cwd: "/tmp" }).thinking, thinking);
  }
  for (const thinking of [null, "", "HIGH", "unknown", 1, true]) {
    assert.throws(() => parseSubagentInput({ ...spawn, thinking }), /thinking must be one of/);
  }
});

test("name and message are required non-empty strings for both actions", () => {
  for (const action of ["spawn", "send"]) {
    for (const field of ["name", "message"]) {
      for (const invalid of [undefined, null, "", " \n\t", 42, false, {}, []]) {
        assert.throws(() => parseSubagentInput({ ...spawn, action, [field]: invalid }), new RegExp(`${field} must be a non-empty string`));
      }
    }
  }
});

test("preserve exact names and messages; impose no path or case rules", () => {
  for (const name of ["Reviewer", "reviewer", "../a/b", "a b", "子代理🔎", " name "]) {
    for (const action of ["spawn", "send"]) {
      const message = " \n完整消息\n ";
      const parsed = parseSubagentInput({ action, name, message });
      assert.equal(parsed.name, name);
      assert.equal(parsed.message, message);
    }
  }
});

test("provider and model, when provided, must be non-empty strings", () => {
  for (const field of ["provider", "model"]) {
    for (const invalid of [null, "", " ", 42, false, {}]) {
      assert.throws(() => parseSubagentInput({ ...spawn, ...explicit, [field]: invalid }), new RegExp(`${field} must be a non-empty string`));
    }
  }
});

test("arguments require a supported action", () => {
  for (const invalid of [undefined, null, [], 1, "spawn", {}, { ...spawn, action: "stop" }, { ...spawn, action: undefined }]) {
    assert.throws(() => parseSubagentInput(invalid));
  }
});

test("send defaults mode to steer and accepts both queue modes", () => {
  const send = { action: "send", name: "Reviewer", message: "More work" };
  assert.deepEqual(parseSubagentInput(send), { ...send, mode: "steer" });
  for (const mode of ["steer", "followUp"]) {
    assert.deepEqual(parseSubagentInput({ ...send, mode }), { ...send, mode });
  }
  for (const mode of [null, "followup", "", "queue", 1]) {
    assert.throws(() => parseSubagentInput({ ...send, mode }), /mode must be/);
  }
});

test("parsing/resolution do not mutate inputs or retain parent configuration references", () => {
  const input = Object.freeze({ ...spawn });
  const snapshot = { cwd: "/first", model: { provider: "first-p", id: "first-m" }, thinkingLevel: "low" as const };
  assert.deepEqual(parseSubagentInput(input), input);
  const result = resolveChildConfig(input, snapshot);
  snapshot.cwd = "/second";
  snapshot.model.id = "second-m";
  assert.deepEqual(result, { cwd: "/first", provider: "first-p", model: "first-m", thinking: "low" });
});
