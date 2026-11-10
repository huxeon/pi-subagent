import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getPackageDir, RpcClient, VERSION } from "@earendil-works/pi-coding-agent";
import type { RpcClientOptions } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_TOOL_NAME } from "./config.ts";
import type { RpcAdapter, RpcAdapterFactory } from "./types.ts";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Locate the CLI of the loaded SDK/host, never argv[1], PATH, or the child's cwd. */
export function resolvePiCliPath(): string {
  // This public SDK function also works when Pi's extension loader supplies host/virtual modules.
  // Honor its PI_PACKAGE_DIR override, but reject relative roots and a different package/version.
  const directory = getPackageDir();
  if (!isAbsolute(directory)) throw new Error("Pi package directory must be absolute");
  const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (!isObject(manifest) || manifest.name !== PI_PACKAGE || manifest.version !== VERSION) {
    throw new Error(`Pi package metadata does not match loaded SDK ${PI_PACKAGE}@${VERSION}`);
  }
  if (!isObject(manifest.bin) || typeof manifest.bin.pi !== "string" || !manifest.bin.pi) {
    throw new Error(`${PI_PACKAGE} does not declare a pi CLI`);
  }
  const cliPath = realpathSync(resolve(directory, manifest.bin.pi));
  if (!statSync(cliPath).isFile()) throw new Error(`Pi CLI is not a file: ${cliPath}`);
  // RpcClient runs `node <cliPath>`, so readability, not an executable bit, is required.
  accessSync(cliPath, constants.R_OK);
  return cliPath;
}

/** Minimal constructor seam: production always uses the official RpcClient. */
export type RpcClientCreator = (options: RpcClientOptions) => RpcAdapter;

export function createRpcAdapterFactory(
  createClient: RpcClientCreator = (options) => new RpcClient(options),
): RpcAdapterFactory {
  return (config) => {
    const client = createClient({
      cliPath: resolvePiCliPath(),
      cwd: config.cwd,
      provider: config.provider,
      model: config.model,
      args: ["--no-session", "--thinking", config.thinking, "--exclude-tools", SUBAGENT_TOOL_NAME],
    });
    let launch: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;

    // One child per adapter. Coalesce stop calls: the SDK's stop is bounded (SIGTERM,
    // then SIGKILL after 1s), including an already-exited child, but is not concurrency-safe.
    // Wait only for SDK.start's 100ms launch check, NOT the getState RPC (30s deadline).
    function stop(): Promise<void> {
      return stopping ??= (async () => {
        await launch?.catch(() => {});
        await client.stop();
      })();
    }

    return {
      async start() {
        if (launch || stopping) throw new Error("RPC adapter already started or stopped");
        try {
          launch = client.start();
          await launch;
          if (stopping) throw new Error("RPC adapter stopped during startup");
          await client.getState();
          if (stopping) throw new Error("RPC adapter stopped during startup");
        } catch (error) {
          // Preserve the startup/handshake error even if cleanup also fails.
          try { await stop(); } catch { /* stop() still exposes its failure to the caller. */ }
          throw error;
        }
      },
      getState: () => client.getState(),
      // Keep argument count, images, mode, disposition, and rejection unchanged.
      // Callers use prompt(message) initially and prompt(message, undefined, mode) later.
      prompt: (...args) => client.prompt(...args),
      onEvent: (listener) => client.onEvent(listener),
      // Pi 1.5.0's empty-session RPC can omit text (undefined), despite its null declaration.
      getLastAssistantText: async () => (await client.getLastAssistantText()) ?? null,
      stop,
    };
  };
}

export const createRpcAdapter: RpcAdapterFactory = createRpcAdapterFactory();
