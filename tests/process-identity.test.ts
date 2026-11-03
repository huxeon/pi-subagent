import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { getSubagentPaths } from "../src/paths.ts";
import { TmuxProcessDriver } from "../src/process-driver.ts";

test("process exit race: inaccessible environ is ignored only after positive exit evidence; opaque live Pi remains fail-closed", async t => {
  const paths = getSubagentPaths("/test-owned-agent", "parent", "worker");
  const driver = new TmuxProcessDriver({ entry: "/test-entry" });
  // Exercise the existing private identity primitive without scanning or signalling
  // any actual process. Built-in mocks are confined to this Node test-file worker.
  const identity = (driver as unknown as { identity(pid: number, target: typeof paths): Promise<unknown> }).identity.bind(driver);
  const denied = Object.assign(new Error("exit-time environ permission failure"), { code: "EACCES" });
  let state = "S";
  let missing = false;
  let statReads = 0;
  t.mock.method(fs, "stat", async () => ({ uid: process.getuid?.() }));
  t.mock.method(fs, "readFile", async (file: string) => {
    if (file.endsWith("/cmdline")) return "pi\0";
    if (file.endsWith("/environ")) throw denied;
    if (file.endsWith("/stat")) {
      statReads++;
      if (statReads > 1 && missing) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      // First read is live, second models the state after environ EACCES.
      return `123 (pi) ${statReads > 1 ? state : "S"} ` + Array(19).fill("1").join(" ");
    }
    throw new Error(`Unexpected path: ${file}`);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(identity(123, paths), error => error === denied);
  statReads = 0; state = "Z";
  assert.equal(await identity(123, paths), undefined);
  statReads = 0; missing = true; state = "S";
  assert.equal(await identity(123, paths), undefined);
});
