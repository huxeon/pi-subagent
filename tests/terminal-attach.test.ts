import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

// Run the production spawnSync path in an isolated process, with a test-owned
// tmux executable. No user terminal, session, or tmux server is touched.
test("tmux attach suppresses client stdout but retains errors and always restores TUI", async t => {
  if (process.platform === "win32") { t.skip("POSIX executable fixture"); return; }
  const root = await mkdtemp(join(tmpdir(), "pi-attach-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "tmux"), `#!/bin/sh
printf '[detached (from session test)]\n'
if [ "$PROBE_ATTACH_FAIL" = 1 ]; then
  printf 'attach denied\n' >&2
  exit 1
fi
`, { mode: 0o700 });
  const moduleUrl = new URL("../src/parent-ui.ts", import.meta.url).href;
  const script = `
    import { attachTerminal } from ${JSON.stringify(moduleUrl)};
    const calls = [];
    let failure;
    const tui = {
      stop(options) { calls.push(["stop", options]); },
      start() { calls.push(["start"]); },
      requestRender(force) { calls.push(["render", force]); },
    };
    try { attachTerminal(tui, "=test"); }
    catch (error) { failure = error.message; }
    console.log(JSON.stringify({ calls, failure }));
  `;
  for (const fails of [false, true]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: root,
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, PROBE_ATTACH_FAIL: fails ? "1" : "0" },
      encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("[detached"));
    assert.equal(result.stderr, fails ? "attach denied\n" : "");
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.calls, [["stop", { preserveScreen: true }], ["start"], ["render", true]]);
    assert.equal(report.failure, fails ? "tmux attach-session failed (1)" : undefined);
  }
});
