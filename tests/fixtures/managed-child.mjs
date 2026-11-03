#!/usr/bin/env node
// Controlled offline Pi stand-in. Only test-owned tmux sessions use this executable.
import { writeFileSync } from 'node:fs';
import { SocketServer } from '../../src/socket-transport.ts';
import { readSessionRecord } from '../../src/session-record.ts';
const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const file = value('--session');
const config = process.argv.includes('--provider') ? {
  provider: value('--provider'), model: value('--model'), thinking: value('--thinking'), cwd: process.cwd(),
} : await readSessionRecord(file);
const runDir = process.env.PI_SUBAGENT_RUN_DIR;
process.title = 'pi'; // Match the actual 1.5 CLI, which overwrites /proc cmdline.
const server = await SocketServer.listen(runDir, (method, params) => {
  if (method === 'identity') return { ...config, pid: process.pid, runDir, sessionFile: file };
  if (method === 'inspect') return { state: 'idle' };
  if (method === 'message') {
    const timestamp = new Date().toISOString();
    writeFileSync(file, [
      { type: 'session', version: 3, id: 'controlled', timestamp, cwd: config.cwd },
      { type: 'model_change', id: 'm', parentId: null, timestamp, provider: config.provider, modelId: config.model },
      { type: 'thinking_level_change', id: 't', parentId: 'm', timestamp, thinkingLevel: config.thinking },
      { type: 'message', id: 'u', parentId: 't', timestamp, message: { role: 'user', content: params.prompt, timestamp: Date.now() } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    return { invoked: true };
  }
  throw new Error('unexpected request');
});
let stopping = false;
process.on('SIGTERM', async () => {
  if (stopping) return;
  stopping = true;
  await new Promise(resolve => setTimeout(resolve, 100));
  await server.close();
  writeFileSync(process.env.PI_TEST_STOP_PROOF, 'async shutdown completed');
  process.exit(0);
});
