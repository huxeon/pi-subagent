import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { resolveAgentDir } from "../src/agent-dir.ts";
import { decodeName, encodeName, encodeParentSession, validateName } from "../src/names.ts";
import { createSubagentDirectory, getParentPaths, getSubagentPaths, normalizeAbsolutePath, scanSubagents } from "../src/paths.ts";
import { hashRunDirectory, prepareSocketAddress, socketPathFor } from "../src/socket-path.ts";
import type { Availability, SubagentOperation } from "../src/types.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-foundation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("default entry is a side-effect-free factory; internal types", () => {
  const events: string[] = [];
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = new Proxy({}, { get(_target, key) {
    if (key === "on") return (event: string) => { events.push(event); return () => {}; };
    if (key === "registerCommand") return (name: string) => { commands.push(name); };
    if (key === "registerTool") return (tool: { name: string }) => { tools.push(tool.name); };
    throw new Error("Factory must only register lifecycle events and the tool");
  } }) as ExtensionAPI;
  const previousRunDir = process.env.PI_SUBAGENT_RUN_DIR;
  try {
    // This test exercises the parent factory even when run from a child agent.
    delete process.env.PI_SUBAGENT_RUN_DIR;
    assert.equal(extension(pi), undefined);
  } finally {
    if (previousRunDir === undefined) delete process.env.PI_SUBAGENT_RUN_DIR;
    else process.env.PI_SUBAGENT_RUN_DIR = previousRunDir;
  }
  assert.deepEqual(events, ["session_start", "session_shutdown", "session_start"]);
  assert.deepEqual(commands, ["subagent"]);
  assert.deepEqual(tools, ["subagent"]);
  const operations: SubagentOperation[] = [
    { operation: "spawn", name: "a", prompt: "p", thinking: "high" },
    { operation: "send", name: "a", prompt: "p", followUp: true },
    { operation: "list" },
    { operation: "status", name: "a" },
    { operation: "wait", name: "a", timeout: 1 },
    { operation: "stop", name: "a" },
  ];
  const observations: Availability[] = [
    { available: true, workState: "working" }, { available: true, workState: "idle" },
    { available: false, reason: "stopped" },
    { available: false, reason: "connection-error", error: { code: "ECONNREFUSED", message: "offline" } },
  ];
  assert.deepEqual(operations.map(input => input.operation), ["spawn", "send", "list", "status", "wait", "stop"]);
  assert.equal(observations.length, 4);
});

test("names preserve exact identity, canonical reversible mapping, no traversal or collisions", () => {
  const names = ["中文协作者", "a", "A", " a ", ".", "..", "../../escape", "/absolute", "a/b", "a\\b", "%2F", "a:b *?'\"", "😀", "é", "e\u0301", "n-61"];
  const encoded = names.map(encodeName);
  assert.equal(new Set(encoded).size, names.length);
  for (const [i, component] of encoded.entries()) {
    assert.match(component, /^n-[a-f0-9]+$/u);
    assert.equal(decodeName(component), names[i]);
  }
  assert.notEqual(encodeParentSession("a"), encodeName("a"));
  for (const value of ["", " ", "\n", "a\0b", "a\x7fb", "\ud800", "a".repeat(127), "中".repeat(43)]) {
    assert.throws(() => validateName(value));
  }
  assert.equal(encodeName("a".repeat(126)).length, 254);
  for (const value of ["plain", "n-", "n-6A", "n-0", "n-ff", "n-eda080", "n-20", "../n-61"]) {
    assert.equal(decodeName(value), undefined);
  }
});

test("agent-dir delegates host env handling and freezes relative paths against explicit cwd", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "relative-agent";
    assert.equal(resolveAgentDir("/startup"), "/startup/relative-agent");
    process.env.PI_CODING_AGENT_DIR = "/custom/agent/";
    assert.equal(resolveAgentDir("/startup"), "/custom/agent");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("absolute lexical normalization and deterministic isolated paths", () => {
  assert.equal(normalizeAbsolutePath("a/../b//", "/base"), "/base/b");
  assert.equal(normalizeAbsolutePath("/base/./b/../"), "/base");
  assert.throws(() => normalizeAbsolutePath("relative"));
  assert.throws(() => normalizeAbsolutePath("x", "relative"));
  assert.throws(() => normalizeAbsolutePath("/a\0b"));
  const child = getSubagentPaths("/agent", "parent1", "../../escape");
  assert.equal(child.runDir, join(child.parentDir, encodeName("../../escape")));
  assert.equal(child.sessionFile, join(child.runDir, "session.jsonl"));
  assert.notEqual(child.runDir, getSubagentPaths("/agent", "parent2", child.name).runDir);
});

test("exclusive reservation, read-only scan including empty relationships and unrelated data", async t => {
  const root = await fixture(t);
  assert.deepEqual(await scanSubagents(root, "p"), []);
  const a = await createSubagentDirectory(root, "p", "中文");
  const b = await createSubagentDirectory(root, "p", "../safe");
  await createSubagentDirectory(root, "other", "中文");
  assert.deepEqual(await readdir(a.runDir), []);
  await assert.rejects(createSubagentDirectory(root, "p", "中文"), { code: "EEXIST" });
  await writeFile(b.sessionFile, "not parsed by discovery\n");
  const parent = a.parentDir;
  await mkdir(join(parent, "unrelated"));
  await writeFile(join(parent, "unrelated", "important"), "keep");
  await mkdir(join(parent, "n-FF"));
  await writeFile(join(parent, encodeName("file")), "keep");
  await symlink(a.runDir, join(parent, encodeName("link")));
  const unsafe = await createSubagentDirectory(root, "p", "unsafe-session");
  await symlink(b.sessionFile, unsafe.sessionFile);
  const before = await readdir(parent);
  const found = await scanSubagents(root, "p");
  assert.deepEqual(new Set(found.map(x => x.name)), new Set([a.name, b.name]));
  assert.deepEqual(await readdir(parent), before);
  assert.equal(await readFile(join(parent, "unrelated", "important"), "utf8"), "keep");
  assert.equal(await readFile(b.sessionFile, "utf8"), "not parsed by discovery\n");
  assert.equal(basename(found[0].sessionFile), "session.jsonl");
});

test("managed ancestors reject symlinks and non-directories without touching targets", async t => {
  const root = await fixture(t);
  const target = join(root, "target");
  await mkdir(target);
  await symlink(target, join(root, "subagents"));
  await assert.rejects(scanSubagents(root, "p"), /Unsafe managed/);
  await assert.rejects(createSubagentDirectory(root, "p", "a"), /Unsafe managed/);
  assert.deepEqual(await readdir(target), []);
  await rm(join(root, "subagents"));
  await mkdir(join(root, "subagents"));
  await writeFile(getParentPaths(root, "p").parentDir, "keep");
  await assert.rejects(scanSubagents(root, "p"), /Unsafe managed/);
});

test("hash uses normalized absolute UTF-8 path, stable SHA-256 prefix", () => {
  const run = "/agent/中文";
  assert.equal(hashRunDirectory(run), createHash("sha256").update(run).digest("hex").slice(0, 32));
  assert.equal(hashRunDirectory(run), hashRunDirectory("/agent/./中文/"));
  assert.notEqual(hashRunDirectory(run), hashRunDirectory("/other/中文"));
  assert.throws(() => hashRunDirectory("relative"));
  const path = socketPathFor(run, "/run/user/1000/pi-subagent");
  assert.match(path, /\/[a-f0-9]{32}\.sock$/u);
  assert.equal(Buffer.byteLength(path), 64);
  assert.equal(socketPathFor(run, "/r", 40).length, 40);
  assert.throws(() => socketPathFor(run, "/r", 39), /exceeds/);
  assert.equal(Buffer.byteLength(socketPathFor(run, `/${"a".repeat(68)}`, 107)), 107);
  assert.throws(() => socketPathFor(run, `/${"a".repeat(69)}`, 107), /exceeds/);
  assert.throws(() => socketPathFor(run, `/${"中".repeat(30)}`), /exceeds/);
});

test("valid XDG, invalid XDG fallback, private runtime directories and no socket writes", async t => {
  const root = await fixture(t);
  const xdg = join(root, "xdg");
  await mkdir(xdg, { mode: 0o700 });
  const options = { xdgRuntimeDir: xdg, tmpRoot: root };
  const addr = await prepareSocketAddress("/agent/run", options);
  assert.equal(addr.runtimeDir, join(xdg, "pi-subagent"));
  assert.equal((await lstat(addr.runtimeDir)).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(addr.runtimeDir), []);
  assert.deepEqual(await prepareSocketAddress("/agent/./run/", options), addr);
  await chmod(xdg, 0o755);
  const fallback = await prepareSocketAddress("/agent/run", options);
  assert.equal(fallback.runtimeDir, join(root, `pi-subagent-${process.getuid!()}`));
  assert.equal((await lstat(fallback.runtimeDir)).mode & 0o7777, 0o700);
  for (const invalid of ["", "relative", join(root, "missing")]) {
    assert.deepEqual(await prepareSocketAddress("/agent/run", { ...options, xdgRuntimeDir: invalid }), fallback);
  }
  await symlink(xdg, join(root, "alias"));
  assert.deepEqual(await prepareSocketAddress("/agent/run", { ...options, xdgRuntimeDir: join(root, "alias") }), fallback);
  // Actual uid mismatch check (never changes ownership).
  const wrongUid = await prepareSocketAddress("/agent/run", { ...options, uid: process.getuid!() + 1 }).catch(e => e);
  assert.ok(wrongUid instanceof Error);
});

test("unsafe runtime leaves fail closed, never chmod/remove; long valid XDG reports length", async t => {
  const root = await fixture(t);
  const xdg = join(root, "xdg");
  await mkdir(xdg, { mode: 0o700 });
  const leaf = join(xdg, "pi-subagent");
  await mkdir(leaf, { mode: 0o755 });
  await assert.rejects(prepareSocketAddress("/run", { xdgRuntimeDir: xdg, tmpRoot: root }), /Unsafe runtime/);
  assert.equal((await lstat(leaf)).mode & 0o777, 0o755);
  await rm(leaf, { recursive: true });
  await symlink(root, leaf);
  await assert.rejects(prepareSocketAddress("/run", { xdgRuntimeDir: xdg }), /Unsafe runtime/);
  await rm(leaf);
  await assert.rejects(prepareSocketAddress("/run", { xdgRuntimeDir: xdg, maxBytes: 10 }), /exceeds/);
  assert.deepEqual(await readdir(xdg), []);
  const longXdg = join(root, "x".repeat(80));
  await mkdir(longXdg, { mode: 0o700 });
  await assert.rejects(prepareSocketAddress("/run", { xdgRuntimeDir: longXdg }), /exceeds/);
  assert.deepEqual(await readdir(longXdg), []);
  const fallback = join(root, `pi-subagent-${process.getuid!()}`);
  await writeFile(fallback, "keep");
  await assert.rejects(prepareSocketAddress("/run", { xdgRuntimeDir: "", tmpRoot: root }), /Unsafe runtime/);
  assert.equal(await readFile(fallback, "utf8"), "keep");
  await chmod(root, 0o777);
  await assert.rejects(prepareSocketAddress("/run", { xdgRuntimeDir: "", tmpRoot: root }), /Unsafe temporary root/);
});
