import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { normalizeAbsolutePath } from "./paths.ts";

export function hashRunDirectory(runDir: string): string {
  return createHash("sha256").update(normalizeAbsolutePath(runDir), "utf8").digest("hex").slice(0, 32);
}

export function socketPathFor(runDir: string, runtimeDir: string, maxBytes = process.platform === "linux" ? 107 : 103): string {
  const path = join(normalizeAbsolutePath(runtimeDir), `${hashRunDirectory(runDir)}.sock`);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || Buffer.byteLength(path, "utf8") > maxBytes) {
    throw new Error(`Unix socket path exceeds ${maxBytes} bytes: ${path}`);
  }
  return path;
}

async function assertPrivateDirectory(path: string, uid: number): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) {
    throw new Error(`Unsafe runtime directory (requires owner ${uid}, mode 0700, no symlinks): ${path}`);
  }
}

async function ensurePrivateDirectory(path: string, uid: number): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Never chmod/chown an existing unsafe directory, follow links or remove anything.
  await assertPrivateDirectory(path, uid);
}

export interface SocketAddressOptions {
  xdgRuntimeDir?: string;
  uid?: number;
  /** Test seam; production fallback is always /tmp, not TMPDIR. */
  tmpRoot?: string;
  maxBytes?: number;
}

/** Prepares only a private directory. Does not listen/connect/probe/unlink sockets. */
export async function prepareSocketAddress(runDir: string, options: SocketAddressOptions = {}): Promise<{ runtimeDir: string; socketPath: string }> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new Error("Unix uid required");
  // Normalize before any filesystem side effects.
  const normalizedRunDir = normalizeAbsolutePath(runDir);
  const xdg = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR;
  let validXdg: string | undefined;
  if (xdg && isAbsolute(xdg) && !xdg.includes("\0")) {
    const path = normalizeAbsolutePath(xdg);
    try { await assertPrivateDirectory(path, uid); validXdg = path; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && !["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(code)) throw error;
      // Invalid XDG falls back; an unsafe extension subdirectory does NOT.
    }
  }
  let runtimeDir: string;
  if (validXdg) {
    runtimeDir = join(validXdg, "pi-subagent");
  } else {
    const tmp = normalizeAbsolutePath(options.tmpRoot ?? "/tmp");
    const stat = await lstat(tmp);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(tmp) !== tmp ||
        (stat.uid !== 0 && stat.uid !== uid) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
      throw new Error(`Unsafe temporary root: ${tmp}`);
    }
    runtimeDir = join(tmp, `pi-subagent-${uid}`);
  }
  // A valid but too-long XDG path is reported, not silently remapped.
  const socketPath = socketPathFor(normalizedRunDir, runtimeDir, options.maxBytes);
  await ensurePrivateDirectory(runtimeDir, uid);
  return { runtimeDir, socketPath };
}
