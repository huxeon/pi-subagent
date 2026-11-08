// Process-lifecycle fixture only: no RPC/JSONL implementation, and no model or resources.
import { existsSync, writeFileSync } from "node:fs";

if (process.env.PI_TEST_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
setInterval(() => {
  if (existsSync(process.env.PI_TEST_EXIT_FILE)) process.exit(0);
}, 10);
writeFileSync(process.env.PI_TEST_READY_FILE, String(process.pid));
