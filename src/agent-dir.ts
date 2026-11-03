import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeAbsolutePath } from "./paths.ts";

/** Pi owns env/tilde/default handling; freeze a relative host setting against startup cwd. */
export function resolveAgentDir(base = process.cwd()): string {
  return normalizeAbsolutePath(getAgentDir(), base);
}
