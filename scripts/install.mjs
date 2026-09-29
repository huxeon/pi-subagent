#!/usr/bin/env node
/**
 * `postinstall` hook for the pi-subagent package.
 *
 * The bundled subagent example discovers agents from `~/.pi/agent/agents` and
 * Pi loads prompt templates from `~/.pi/agent/prompts`. This script copies the
 * example's `agents/` and `prompts/` into those directories, replacing the
 * manual `ln -s` steps from the example README.
 *
 * `pi install npm:...` / `git:...` run `npm install`, so this runs right after
 * installation. Existing files are never overwritten, so user edits win.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const subagentDir = path.join(packageRoot, "extensions", "subagent");

function expandTilde(input) {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
	return input;
}

/** Same resolution as Pi's `getAgentDir()`. */
function getAgentDir() {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv && fromEnv.trim()) return expandTilde(fromEnv.trim());
	return path.join(os.homedir(), ".pi", "agent");
}

function listMarkdownFiles(dir) {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function copyInto(sourceDir, destinationDir) {
	const result = { copied: 0, skipped: 0, errors: [] };
	for (const name of listMarkdownFiles(sourceDir)) {
		const to = path.join(destinationDir, name);
		try {
			if (fs.existsSync(to)) {
				result.skipped += 1;
				continue;
			}
			fs.mkdirSync(destinationDir, { recursive: true });
			fs.copyFileSync(path.join(sourceDir, name), to);
			result.copied += 1;
		} catch (error) {
			result.errors.push({ path: to, error });
		}
	}
	return result;
}

try {
	const agentDir = getAgentDir();
	const agents = copyInto(path.join(subagentDir, "agents"), path.join(agentDir, "agents"));
	const prompts = copyInto(path.join(subagentDir, "prompts"), path.join(agentDir, "prompts"));

	const copied = agents.copied + prompts.copied;
	const skipped = agents.skipped + prompts.skipped;
	const errors = [...agents.errors, ...prompts.errors];

	if (copied > 0 || errors.length > 0) {
		const detail = errors.length > 0 ? `, ${errors.length} failed` : "";
		console.log(`[pi-subagent] Seeded ${copied} file(s) into ${agentDir}${detail}${skipped > 0 ? ` (${skipped} kept)` : ""}.`);
	}

	for (const { path: filePath, error } of errors) {
		console.warn(`[pi-subagent] Could not write ${filePath}: ${error instanceof Error ? error.message : error}`);
	}
} catch (error) {
	console.warn(`[pi-subagent] Skipped resource seeding: ${error instanceof Error ? error.message : error}`);
}
