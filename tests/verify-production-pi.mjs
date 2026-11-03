// Opt-in real Pi CLI/production bridge+manager+driver probe. Never submits a prompt.
// All tmux/process/session resources are owned by this probe; no user terminal attach.
// Usage: PI_PACKAGE_DIR=/absolute/path/to/@earendil-works/pi-coding-agent node tests/verify-production-pi.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ParentManager } from '../src/parent-manager.ts';
import { TmuxProcessDriver, tmuxSessionName } from '../src/process-driver.ts';
import { createSubagentDirectory } from '../src/paths.ts';
import { SocketClient } from '../src/socket-transport.ts';

assert(process.env.PI_PACKAGE_DIR, 'Set PI_PACKAGE_DIR to installed Pi package directory');
const pkg = resolve(process.env.PI_PACKAGE_DIR);
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pi-production-'));
const agent = join(root, 'agent');
const xdg = join(root, 'xdg');
const tmuxArgs = ['-S', join(root, 'tmux'), '-f', '/dev/null'];
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TERM: 'xterm-256color',
  XDG_RUNTIME_DIR: xdg, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
  PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agent };
const managers = [];
const records = join(root, 'observations.jsonl');
const observations = async () => (await readFile(records, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const tmux = (...args) => execFileSync('tmux', [...tmuxArgs, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
async function until(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out; observations=${JSON.stringify(await observations())}`);
}
let driver, paths;
try {
  await mkdir(agent); await mkdir(xdg, { mode: 0o700 }); await mkdir(env.HOME);
  await mkdir(join(agent, 'extensions')); await mkdir(join(agent, 'skills/probe'), { recursive: true });
  await writeFile(join(agent, 'skills/probe/SKILL.md'), '---\nname: probe\ndescription: Offline discovery sentinel\n---\nDo not run a model.\n');
  await writeFile(join(agent, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'offline-not-real' } }));
  await writeFile(join(agent, 'settings.json'), JSON.stringify({
    extensions: [entry], defaultProvider: 'openai', defaultModel: 'gpt-4o', defaultThinkingLevel: 'off',
    quietStartup: true, checkForUpdates: false, packages: [],
  }));
  // Ordinary normally discovered extension observes real runtime resources; not a replacement bridge.
  await writeFile(join(agent, 'extensions/observer.ts'), `
import { appendFileSync } from 'node:fs';
const log = value => appendFileSync(${JSON.stringify(records)}, JSON.stringify(value)+'\\n');
export default function(pi) {
  pi.on('cache_warming_decision', () => ({action:'stop'}));
  pi.on('agent_start', () => { log({unexpectedModelRun:true}); throw new Error('No model permitted'); });
  pi.on('session_start', (event,ctx) => log({reason:event.reason,pid:process.pid,cwd:ctx.cwd,
    tools:pi.getAllTools().map(t=>t.name),commands:pi.getCommands().map(c=>c.name)}));
  pi.registerCommand('probe-reload', {handler:async (_,ctx)=>{await ctx.reload();}});
}`);
  const launcher = join(root, 'pi-test-launcher');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(pkg, 'dist/bundle/cli.js'))} --offline "$@"\n`, { mode: 0o700 });
  driver = new TmuxProcessDriver({ entry, executable: launcher, env, tmuxArgs });
  paths = await createSubagentDirectory(agent, 'offline-parent', 'real-Pi');
  const sm = SessionManager.open(paths.sessionFile, undefined, root);
  sm.appendModelChange('openai', 'gpt-5'); sm.appendThinkingLevelChange('high');
  sm.appendMessage({ role: 'user', content: 'Saved interrupted task. Never replay.', timestamp: Date.now() });
  const original = await readFile(paths.sessionFile, 'utf8');
  const manager = () => {
    const value = new ParentManager({ agentDir: agent, parentSessionId: 'offline-parent', driver,
      transport: { address: { xdgRuntimeDir: xdg } } });
    managers.push(value); return value;
  };
  let current = manager();
  assert.deepEqual(await current.recover(), [{ name: 'real-Pi', connected: true }]);
  assert.equal(await driver.isRunning(paths), true, 'real Pi process title must remain discoverable');
  let client = await SocketClient.connect(paths.runDir, { address: { xdgRuntimeDir: xdg } });
  const identity = await client.request('identity', {}); await client.close();
  assert.equal(identity.cwd, root); assert.equal(identity.model, 'gpt-5'); assert.equal(identity.thinking, 'high');
  assert.deepEqual(await current.inspect('real-Pi', false), { state: 'idle' });
  assert.deepEqual(await current.inspect('real-Pi', true), { state: 'idle', reply: null });
  await until(async () => (await observations()).length > 0);
  const start = (await observations())[0];
  assert(!start.tools.includes('subagent')); assert(!start.commands.includes('subagent'));
  assert(start.commands.includes('skill:probe'), 'normal skill discovery retained');
  console.log('PASS real CLI production entry + normal extension/skill discovery; child has no parent tool/command; saved config, idle/no replay');
  await current.shutdown('reload');
  assert.equal(await driver.isRunning(paths), true);
  current = manager(); await current.recover(); await current.recover();
  client = await SocketClient.connect(paths.runDir, { address: { xdgRuntimeDir: xdg } });
  assert.equal((await client.request('identity', {})).pid, identity.pid); await client.close();
  console.log('PASS production manager reload/repeated recover reconnects to same real Pi PID');
  // Only send a test extension command to this private server. No prompt/model call.
  tmux('send-keys', '-t', `=${tmuxSessionName(paths.runDir)}:0.0`, '-l', '/probe-reload');
  tmux('send-keys', '-t', `=${tmuxSessionName(paths.runDir)}:0.0`, 'Enter');
  await until(async () => (await observations()).some(item => item.reason === 'reload'));
  await current.shutdown('reload'); current = manager();
  assert.deepEqual(await current.recover(), [{ name: 'real-Pi', connected: true }]);
  assert.deepEqual(await current.inspect('real-Pi'), { state: 'idle' });
  console.log('PASS real child /reload closes/reopens production bridge without duplicate bind');
  await current.shutdown('quit');
  assert.equal(await driver.isRunning(paths), false);
  assert.equal(await readFile(paths.sessionFile, 'utf8'), original);
  assert.deepEqual(await readdir(join(xdg, 'pi-subagent')), []);
  current = manager();
  assert.deepEqual(await current.recover(), [{ name: 'real-Pi', connected: true }]);
  assert.deepEqual(await current.inspect('real-Pi', true), { state: 'idle', reply: null });
  await current.destroy('real-Pi'); await current.destroy('real-Pi');
  await assert.rejects(readFile(paths.sessionFile), { code: 'ENOENT' });
  assert.equal(await driver.isRunning(paths), false);
  assert.deepEqual(await readdir(join(xdg, 'pi-subagent')), []);
  assert(!(await observations()).some(item => item.unexpectedModelRun));
  console.log('PASS real Pi graceful stop/history retention, restore idle, destroy all records; no sockets/processes or model runs');
} finally {
  for (const manager of managers) await manager.shutdown('quit').catch(() => {});
  if (driver && paths) await driver.stop(paths);
  // Only our private server; never default tmux or any user session.
  spawnSync('tmux', [...tmuxArgs, 'kill-server'], { stdio: 'ignore' });
  await rm(root, { recursive: true, force: true });
}
