// Offline compatibility probe, not the production extension. No model requests.
// Usage: PI_PACKAGE_DIR=/absolute/path/to/@earendil-works/pi-coding-agent node tests/verify-pi.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.env.PI_PACKAGE_DIR, 'Set PI_PACKAGE_DIR to the installed Pi package directory');
const pkg = resolve(process.env.PI_PACKAGE_DIR);
const { SessionManager, createAgentSession, DefaultResourceLoader, SettingsManager, ModelRuntime } =
  await import(pathToFileURL(join(pkg, 'dist/index.js')).href);
const root = mkdtempSync(join(tmpdir(), 'pi-subagent-verify-'));
const workspace = join(root, 'workspace');
const agentDir = join(root, 'agent');
const eventsFile = join(root, 'events.jsonl');
const tmuxSocket = join(root, 'tmux.sock');
const sessionFile = join(root, 'session.jsonl');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('PI_') || /API_KEY|TOKEN|SECRET/.test(key)) delete env[key];
}
Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1',
  PI_SUBAGENT_RUN_DIR: root, PROBE_EVENTS: eventsFile, PROBE_SOCKET: join(root, 'bridge.sock') });
function tmux(...args) {
  const r = spawnSync('tmux', ['-S', tmuxSocket, ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `tmux ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const events = () => existsSync(eventsFile)
  ? readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function until(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}; events=${JSON.stringify(events())}`);
}
function start(name, file, extra = []) {
  tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', root, '--',
    process.execPath, join(pkg, 'dist/bundle/cli.js'), '--offline', '--session', file,
    '-e', join(agentDir, 'extensions/bridge.ts'), ...extra);
}
try {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(env.HOME, { recursive: true });
  // Authentication is a dummy literal used only for model selection, never sent anywhere.
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'offline-probe-not-real' } }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'openai', defaultModel: 'gpt-4o', defaultThinkingLevel: 'off',
    packages: [], quietStartup: true, checkForUpdates: false,
  }));

  const sm = SessionManager.open(sessionFile, root, workspace);
  sm.appendModelChange('openai', 'gpt-5');
  sm.appendThinkingLevelChange('high');
  assert.equal(existsSync(sessionFile), false, 'setup alone must not flush');
  sm.appendMessage({ role: 'user', content: 'Offline persistence probe; do not replay.', timestamp: Date.now() });
  assert(existsSync(sessionFile), 'first user must flush without assistant');
  const restored = SessionManager.open(sessionFile, root);
  assert.equal(restored.getCwd(), workspace);
  assert.deepEqual(restored.buildSessionContext().model, { provider: 'openai', modelId: 'gpt-5' });
  assert.equal(restored.buildSessionContext().thinkingLevel, 'high');
  assert.equal(restored.getBranch().filter(e => e.type === 'message').length, 1);
  console.log('PASS first-user flush and session-only settings (no assistant)');

  // Exercise the real AgentSession loop with an in-process synthetic stream, no provider transport.
  const settingsManager = SettingsManager.inMemory({ defaultProvider: 'openai', defaultModel: 'gpt-5',
    defaultThinkingLevel: 'high', compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager, noExtensions: true });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
  const sdkFile = join(root, 'sdk.jsonl');
  const { session } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime, settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.open(sdkFile, root, workspace) });
  try {
    let release;
    const gate = new Promise(r => { release = r; });
    let requests = 0;
    const lifecycle = [];
    session.subscribe(event => {
      if (['agent_start', 'agent_end', 'agent_settled'].includes(event.type))
        lifecycle.push({ type: event.type, idle: session.isIdle });
    });
    session.agent.streamFunction = async model => {
      const n = ++requests;
      if (n === 1) await gate;
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: `synthetic reply ${n}` }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; },
        result: async () => message };
    };
    const run = session.prompt('synthetic initial input');
    await until(() => requests === 1, 'synthetic stream starts');
    assert(existsSync(sdkFile), 'real prompt must flush before first assistant response');
    assert(!SessionManager.open(sdkFile, root).getBranch().some(e => e.type === 'message' && e.message.role === 'assistant'));
    assert.equal(session.isIdle, false);
    await session.followUp('synthetic queued follow-up');
    release();
    await run;
    assert.equal(requests, 2);
    assert.equal(session.isIdle, true);
    assert(lifecycle.some(e => e.type === 'agent_end' && !e.idle));
    assert.deepEqual(lifecycle.filter(e => e.type === 'agent_settled'), [{ type: 'agent_settled', idle: true }]);
    assert.equal(session.getLastAssistantText(), 'synthetic reply 2');
    const branch = session.sessionManager.getBranch();
    const user = branch.find(e => e.type === 'message' && e.message.role === 'user');
    session.sessionManager.branch(user.id);
    session.sessionManager.appendMessage({ role: 'user', content: 'alternate branch', timestamp: Date.now() });
    assert(!session.sessionManager.getBranch().some(e => e.type === 'message' && e.message.role === 'assistant'));
    assert(session.sessionManager.getEntries().some(e => e.type === 'message' && e.message.role === 'assistant'));
    console.log('PASS real prompt flush before reply; synthetic follow-up drains before settled/idle; latest reply and branch reads');
  } finally {
    session.dispose();
  }

  writeFileSync(join(agentDir, 'extensions/ordinary.ts'), `
import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', () => appendFileSync(process.env.PROBE_EVENTS, JSON.stringify({type:'ordinary'})+'\\n'));
}`);
  writeFileSync(join(agentDir, 'extensions/bridge.ts'), `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
const log = x => appendFileSync(process.env.PROBE_EVENTS, JSON.stringify(x)+'\\n');
export default function(pi) {
  let server;
  log({type:'factory', child:!!process.env.PI_SUBAGENT_RUN_DIR});
  if (!process.env.PI_SUBAGENT_RUN_DIR) pi.registerTool({name:'subagent', label:'probe', description:'probe', parameters:{type:'object',properties:{}}, execute:async()=>({content:[], details:{}})});
  pi.on('cache_warming_decision', () => ({action:'stop'}));
  pi.on('session_start', async (event, ctx) => {
    server = createServer();
    await new Promise((done, reject) => { server.once('error', reject); server.listen(process.env.PROBE_SOCKET, done); });
    log({type:'start', reason:event.reason, pid:process.pid, cwd:ctx.cwd,
      provider:ctx.model?.provider, model:ctx.model?.id, thinking:ctx.thinkingLevel,
      idle:ctx.isIdle(), tools:pi.getAllTools().map(t=>t.name)});
  });
  pi.on('agent_start', () => { log({type:'unexpected-model-run'}); throw new Error('Probe must never run a model'); });
  pi.registerCommand('probe-reload', {handler:async (_,ctx)=>{await ctx.reload();}});
  pi.registerCommand('probe-invalid-send', {handler:()=>{
    let threw = false, result;
    try { result = pi.sendUserMessage(null); } catch { threw = true; }
    log({type:'send-return', threw, returnedUndefined:result===undefined});
  }});
  pi.on('session_shutdown', async event => {
    await new Promise(r=>setTimeout(r,100));
    await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
    log({type:'shutdown', reason:event.reason, socketExists:false});
  });
}`);
  start('restore', sessionFile);
  let s = await until(() => events().find(e => e.type === 'start'), 'restore startup');
  assert.equal(s.cwd, workspace, 'CLI must use session cwd, not launch cwd');
  assert.equal(s.model, 'gpt-5', 'saved model must beat default gpt-4o');
  assert.equal(s.thinking, 'high');
  assert.equal(s.idle, true);
  assert(!s.tools.includes('subagent'));
  assert.equal(events().filter(e => e.type === 'factory').length, 1, 'discovery + explicit entry dedup');
  assert(events().some(e => e.type === 'ordinary'), 'normal discovery retained');
  console.log('PASS CLI restore: saved cwd/model/thinking; idle; normal discovery + explicit bridge once; child role');
  tmux('send-keys', '-t', 'restore', '-l', '/probe-invalid-send');
  tmux('send-keys', '-t', 'restore', 'Enter');
  const send = await until(() => events().find(e => e.type === 'send-return'), 'void send');
  assert.equal(send.threw, false);
  assert.equal(send.returnedUndefined, true);
  console.log('PASS invalid async send returns void without synchronous throw (delivery-ack conflict)');
  tmux('send-keys', '-t', 'restore', '-l', '/probe-reload');
  tmux('send-keys', '-t', 'restore', 'Enter');
  await until(() => events().find(e => e.type === 'start' && e.reason === 'reload'), 'reload');
  assert(events().some(e => e.type === 'shutdown' && e.reason === 'reload'));
  process.kill(s.pid, 'SIGTERM');
  await until(() => events().find(e => e.type === 'shutdown' && e.reason === 'quit'), 'SIGTERM shutdown');
  await until(() => { try { process.kill(s.pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }, 'Pi exit');
  assert.equal(existsSync(env.PROBE_SOCKET), false);
  assert(existsSync(sessionFile));
  console.log('PASS reload reasons; SIGTERM awaits async shutdown, socket removal and process exit; history retained');

  const fresh = join(root, 'fresh.jsonl');
  start('fresh', fresh, ['--provider', 'openai', '--model', 'gpt-5', '--thinking', 'high']);
  s = await until(() => events().findLast(e => e.type === 'start' && e.pid !== s.pid), 'fresh startup');
  assert.equal(s.model, 'gpt-5');
  assert.equal(s.thinking, 'high');
  assert.equal(existsSync(fresh), false);
  process.kill(s.pid, 'SIGHUP');
  await until(() => { try { process.kill(s.pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }, 'SIGHUP exit');
  assert.equal(existsSync(fresh), false, 'shutdown does not flush setup-only session');
  assert.equal(existsSync(env.PROBE_SOCKET), false);
  assert(!events().some(e => e.type === 'unexpected-model-run'));
  console.log('PASS fresh CLI configuration; no file before first user, even after graceful SIGHUP; zero agent runs');
  console.log(`Pi ${JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version}; all probes passed`);
} finally {
  // This is a private tmux server created solely for this probe, never the user's server.
  spawnSync('tmux', ['-S', tmuxSocket, 'kill-server'], { env, stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
}
