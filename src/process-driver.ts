import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hashRunDirectory } from "./socket-path.ts";
import type { SubagentPaths } from "./paths.ts";
import type { EffectiveConfig } from "./session-record.ts";

export interface ProcessDriver {
  start(paths: SubagentPaths, config?: EffectiveConfig): Promise<void>;
  isRunning(paths: SubagentPaths): Promise<boolean>;
  stop(paths: SubagentPaths): Promise<void>;
}
export function tmuxSessionName(runDir: string): string { return `pi-subagent-${hashRunDirectory(runDir)}`; }
const exec = promisify(execFile);
interface ProcessIdentity { pid: number; birth: string }

/** Linux /proc identity is rechecked before signalling, including process start time.
 * No PID file, shell command construction, or reliance on pane_pid being Pi.
 */
export class TmuxProcessDriver implements ProcessDriver {
  private readonly options: { tmuxArgs?: string[]; executable?: string; entry: string; stopTimeoutMs?: number; env?: NodeJS.ProcessEnv };
  constructor(options: TmuxProcessDriver["options"]) { this.options = options; }
  private async tmux(args: string[]): Promise<string> {
    const result = await exec("tmux", [...(this.options.tmuxArgs ?? []), ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  }
  private async session(paths: SubagentPaths): Promise<string | undefined> {
    // list-sessions avoids treating arbitrary tmux errors as "not found".
    let output: string;
    try { output = await this.tmux(["list-sessions", "-F", "#{session_name}"]); }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      if (/no server running|error connecting .*No such file|no sessions/.test(stderr)) return;
      throw error;
    }
    const name = tmuxSessionName(paths.runDir);
    if (!output.split("\n").includes(name)) return;
    const marker = await this.tmux(["show-environment", "-t", `=${name}`, "PI_SUBAGENT_RUN_DIR"]);
    if (marker !== `PI_SUBAGENT_RUN_DIR=${paths.runDir}`) throw new Error(`Foreign tmux session: ${name}`);
    return name;
  }
  private async identity(pid: number, paths: SubagentPaths): Promise<ProcessIdentity | undefined> {
    try {
      const root = `/proc/${pid}`;
      if ((await stat(root)).uid !== process.getuid?.()) return;
      // Filter by public argv first: unrelated same-UID services can deny environ reads.
      const args = (await readFile(`${root}/cmdline`, "utf8")).split("\0");
      const hasSessionArg = args.some((arg, i) => arg === "--session" && args[i + 1] === paths.sessionFile);
      // Pi 1.5 changes process.title, replacing argv in /proc with just "pi".
      const piTitle = args.filter(Boolean).join(" ") === "pi";
      if (!hasSessionArg && !piTitle) return;
      const status = await readFile(`${root}/stat`, "utf8");
      const fields = status.slice(status.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return;
      const env = await readFile(`${root}/environ`, "utf8");
      const variables = env.split("\0");
      if (!variables.includes(`PI_SUBAGENT_RUN_DIR=${paths.runDir}`) ||
          !variables.includes(`PI_SUBAGENT_SESSION_FILE=${paths.sessionFile}`)) return;
      return { pid, birth: fields[19]! }; // /proc stat field 22, after pid/comm
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      // Linux can deny environ access during exit, after cmdline/stat were read.
      // Ignore only a positively observed zombie or a now-missing process, never
      // an opaque live candidate (which must still fail closed).
      if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        try {
          const status = await readFile(`/proc/${pid}/stat`, "utf8");
          if (status.slice(status.lastIndexOf(")") + 2).split(" ")[0] === "Z") return;
        } catch (recheckError) {
          if (["ENOENT", "ESRCH"].includes((recheckError as NodeJS.ErrnoException).code ?? "")) return;
        }
      }
      throw error; // Fail closed when process ownership cannot be established.
    }
  }
  private async processes(paths: SubagentPaths): Promise<ProcessIdentity[]> {
    if (process.platform !== "linux") throw new Error("Safe process discovery currently requires Linux /proc");
    const results: ProcessIdentity[] = [];
    for (const item of await readdir("/proc")) {
      if (!/^\d+$/.test(item)) continue;
      const found = await this.identity(Number(item), paths);
      if (found) results.push(found);
    }
    return results;
  }
  async isRunning(paths: SubagentPaths): Promise<boolean> {
    const session = await this.session(paths);
    const processes = await this.processes(paths);
    if (processes.length) return true;
    if (session) {
      const dead = await this.tmux(["list-panes", "-t", `=${session}`, "-F", "#{pane_dead}"]);
      // A live launcher may not yet have exec'd Pi. Never start a duplicate.
      if (dead.split("\n").some(value => value !== "1")) return true;
      await this.tmux(["kill-session", "-t", `=${session}`]);
    }
    return false;
  }
  async start(paths: SubagentPaths, config?: EffectiveConfig): Promise<void> {
    if (await this.isRunning(paths)) throw new Error("Child process already running");
    const args = ["--session", paths.sessionFile, "-e", this.options.entry];
    if (config) args.push("--provider", config.provider, "--model", config.model, "--thinking", config.thinking);
    // Multi-argument tmux shell-command executes directly, without sh -c. Forward current
    // environment explicitly: an existing tmux server can have stale XDG/auth/PATH values.
    const environment = { ...(this.options.env ?? process.env), PI_SUBAGENT_RUN_DIR: paths.runDir,
      PI_SUBAGENT_SESSION_FILE: paths.sessionFile, PI_CODING_AGENT_DIR: paths.agentDir };
    const envArgs = Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    await this.tmux(["new-session", "-d", "-s", tmuxSessionName(paths.runDir), "-x", "120", "-y", "40",
      "-c", config?.cwd ?? paths.agentDir, ...envArgs, "--", "env", `PI_SUBAGENT_RUN_DIR=${paths.runDir}`,
      this.options.executable ?? "pi", ...args]);
  }
  async stop(paths: SubagentPaths): Promise<void> {
    const session = await this.session(paths); // Refuse a colliding foreign session.
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 10_000);
    let processes = await this.processes(paths);
    if (session) {
      // A shell/env launcher may still be exec'ing Pi. Wait for identifiable Pi or
      // a dead pane; never kill-session to dispose an unrecognized live process.
      while (await this.session(paths)) {
        let panes: string;
        try { panes = await this.tmux(["list-panes", "-t", `=${session}`, "-F", "#{pane_pid} #{pane_dead}"]); }
        catch (error) { if (!await this.session(paths)) break; throw error; }
        if (panes.split("\n").every(line => {
          const [pid, dead] = line.split(" ");
          return dead === "1" || processes.some(item => item.pid === Number(pid));
        })) break;
        if (Date.now() >= deadline) throw new Error("Cannot safely identify live tmux launcher/pane; resources retained");
        await delay(25);
        processes = await this.processes(paths);
      }
    }
    for (const item of processes) {
      const current = await this.identity(item.pid, paths);
      if (current?.birth !== item.birth) continue;
      try { process.kill(item.pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    while ((await this.processes(paths)).length) {
      if (Date.now() >= deadline) throw new Error("Pi shutdown timed out; records and tmux retained (no forced kill)");
      await delay(25);
    }
    // Only after verified Pi exit, never as a substitute for asynchronous shutdown.
    if (session && await this.session(paths)) await this.tmux(["kill-session", "-t", `=${session}`]);
  }
}
