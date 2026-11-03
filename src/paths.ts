import { lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { decodeName, encodeName, encodeParentSession } from "./names.ts";

/** Lexical normalization only. No ~/$VAR expansion and no filesystem writes. */
export function normalizeAbsolutePath(path: string, base?: string): string {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("Invalid path");
  if (!isAbsolute(path) && (!base || !isAbsolute(base) || base.includes("\0"))) {
    throw new Error("Relative paths require an explicit absolute base");
  }
  return base === undefined ? resolve(path) : resolve(base, path);
}

export interface ParentPaths {
  agentDir: string;
  subagentsDir: string;
  parentDir: string;
}
export interface SubagentPaths extends ParentPaths {
  name: string;
  runDir: string;
  sessionFile: string;
}

/** Pass Pi's getAgentDir() here; do not independently reproduce Pi env/default rules. */
export function getParentPaths(agentDir: string, parentSessionId: string, base?: string): ParentPaths {
  const root = normalizeAbsolutePath(agentDir, base);
  const subagentsDir = join(root, "subagents");
  return { agentDir: root, subagentsDir, parentDir: join(subagentsDir, encodeParentSession(parentSessionId)) };
}

export function getSubagentPaths(agentDir: string, parentSessionId: string, name: string, base?: string): SubagentPaths {
  const parent = getParentPaths(agentDir, parentSessionId, base);
  const runDir = join(parent.parentDir, encodeName(name));
  return { ...parent, name, runDir, sessionFile: join(runDir, "session.jsonl") };
}

export async function lstatIfPresent(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function checkDirectory(path: string): Promise<boolean> {
  const stat = await lstatIfPresent(path);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe managed directory: ${path}`);
  return true;
}

/** Read-only, direct children only. An empty run directory is still a relationship. */
export async function scanSubagents(agentDir: string, parentSessionId: string, base?: string): Promise<SubagentPaths[]> {
  const paths = getParentPaths(agentDir, parentSessionId, base);
  if (!await checkDirectory(paths.subagentsDir) || !await checkDirectory(paths.parentDir)) return [];
  const found: SubagentPaths[] = [];
  for (const entry of await readdir(paths.parentDir, { withFileTypes: true })) {
    const name = decodeName(entry.name);
    if (name === undefined || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = getSubagentPaths(paths.agentDir, parentSessionId, name);
    if (!await checkDirectory(child.runDir)) continue;
    const session = await lstatIfPresent(child.sessionFile);
    // Missing is valid (initial startup can be setup-only); links/devices are not.
    if (session && (!session.isFile() || session.isSymbolicLink())) continue;
    found.push(child);
  }
  return found.sort((a, b) => a.runDir < b.runDir ? -1 : a.runDir > b.runDir ? 1 : 0);
}

/** Exclusive reservation: EEXIST is intentionally not swallowed. Never prewrite JSONL. */
export async function createSubagentDirectory(agentDir: string, parentSessionId: string, name: string, base?: string): Promise<SubagentPaths> {
  const paths = getSubagentPaths(agentDir, parentSessionId, name, base);
  // The agent root is owned/configured by Pi and must already exist. It may be a user symlink.
  for (const path of [paths.subagentsDir, paths.parentDir]) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await checkDirectory(path);
  }
  await mkdir(paths.runDir, { mode: 0o700 });
  return paths;
}
