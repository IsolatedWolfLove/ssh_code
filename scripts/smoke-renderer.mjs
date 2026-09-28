// Optional browser smoke test: CHROME=/path/to/chrome node scripts/smoke-renderer.mjs
// Uses the built renderer and a Wails transport fixture, without an Electron preload.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/dist');
const profile = await mkdtemp(join(tmpdir(), 'ssh-studio-chrome-'));
const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.ttf': 'font/ttf' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { const content = await readFile(file); res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); res.end(content); }
  catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless', '--disable-gpu', '--no-first-run', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => { let log = ''; chrome.stderr.on('data', chunk => { log += chunk; const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); }); chrome.on('error', reject); chrome.on('exit', code => reject(new Error(`Chrome exited ${code}: ${log}`))); setTimeout(() => reject(new Error('Chrome startup timed out')), 15000).unref(); });
  console.log('Chrome started');
  socket = new WebSocket(endpoint); await once(socket, 'open');
  console.log('DevTools connected');
  let id = 0; const pending = new Map(); const errors = []; const loaded = [];
  socket.addEventListener('message', ({ data }) => { const msg = JSON.parse(data); if (msg.id) { const task = pending.get(msg.id); pending.delete(msg.id); if (msg.error) task?.reject(new Error(JSON.stringify(msg.error))); else task?.resolve(msg.result); } if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails); if (msg.method === 'Network.loadingFailed') console.log('Network error:', msg.params.errorText); if (msg.method === 'Page.loadEventFired') loaded.splice(0).forEach(fn => fn()); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  console.log('Page attached');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    const listeners = new Map(); window.__calls = [];
    window.runtime = { EventsOnMultiple(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); } };
    window.__emit = (name, data) => { for (const fn of listeners.get(name) || []) fn(data); };
    window.go = { app: { App: new Proxy({}, { get(_, name) { return async (...args) => {
      window.__calls.push(name);
      if (['ListSavedConnections', 'ListTailscaleHosts', 'ReadDir', 'ListTunnels'].includes(name)) return [];
      if (name === 'GetRemoteShellSupport') return { kind: 'none', sessions: [] };
      if (name === 'GetIdleTransferSnapshot' || name === 'StartAutomaticMediaCache') return { queuedItems: 0, queuedPaths: [], cachedBytes: 0, cacheLimitBytes: 1000, manualGroups: [] };
      if (name === 'CreateTerminal') return { terminalId: 'terminal-1' };
      if (name === 'GetTransferCapabilities') return { localRsync: false, remoteRsync: false };
      return undefined;
    }; } }) } };
  ` });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const health = await fetch(url); if (!health.ok) throw new Error('Renderer assets missing; run npm run build:wails-frontend first');
  const load = new Promise(resolve => loaded.push(resolve));
  const navigation = await call('Page.navigate', { url }); if (navigation.errorText) throw new Error(navigation.errorText); await Promise.race([load, new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 12000).unref())]);
  console.log('Page loaded');
  const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await evaluate('new Promise(resolve => setTimeout(resolve, 800))');
  const initial = await evaluate('document.querySelector("#root")?.innerText ?? JSON.stringify({url:location.href,text:document.body.innerText})');
  if (!initial.toLowerCase().includes('ssh studio') || initial.length < 100) throw new Error('Initial renderer did not mount: '+initial);
  await evaluate(`window.__emit('connection:state', { state: 'connected', connectionId: 'connection-1', homeDir: '/tmp', filesystemState: 'ready', message: 'Connected' }); new Promise(resolve => setTimeout(resolve, 1000))`);
  const calls = await evaluate('window.__calls');
  for (const name of ['ListSavedConnections', 'GetIdleTransferSnapshot', 'StartHostMetrics']) if (!calls.includes(name)) throw new Error(`Missing connected lifecycle call ${name}`);
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log('Renderer smoke passed: initial mount and connected lifecycle, no uncaught exceptions.');
  await send('Browser.close');
} finally {
  socket?.close(); chrome.kill(); server.close();
  // Chrome may need a moment to finish releasing its temporary profile.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
