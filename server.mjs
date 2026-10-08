#!/usr/bin/env node
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConfigStore, publicConfig } from './lib/config.mjs';
import { createDashboard } from './lib/connectors.mjs';
import { createAssistant } from './lib/assistant.mjs';
import { transcribe, voiceCapabilities, cancelVoice } from './lib/voice.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const exec = promisify(execFile);
const APPS = ['Calculator', 'TextEdit', 'Finder'];
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

async function staticFiles() {
  const files = new Map([['/', 'index.html'], ['/index.html', 'index.html']]);
  async function walk(directory) {
    for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile() && MIME[path.extname(entry.name)]) files.set(`/${relative}`, relative);
    }
  }
  for (const directory of ['js', 'css', 'assets/fonts']) await walk(directory);
  return files;
}
function body(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0, exceeded = false; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > cap) { exceeded = true; chunks.length = 0; }
      else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => exceeded ? reject(Object.assign(new Error('Request body is too large'), { status: 413 })) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request cancelled')));
  });
}
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw Object.assign(new Error('Use application/json'), { status: 415 });
  try { const result = JSON.parse((await body(req, 64 * 1024)).toString('utf8')); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; }
  catch (error) { if (error.status) throw error; throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}
export async function createApp({ configDir, port = 0, fetchImpl = fetch } = {}) {
  const store = await createConfigStore(configDir), files = await staticFiles();
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const dashboard = createDashboard({ store, fetchImpl });
  const assistant = createAssistant({ getConfig: store.get, getDashboard: () => dashboard.load() });
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const active = new Set();
  let origin = '', origins = new Set(), hosts = new Set();
  const capabilities = async () => ({ assistant: await assistant.capabilities(), voice: await voiceCapabilities(store.get()), desktop: { available: process.platform === 'darwin', apps: APPS } });
  function authorized(req) {
    const provided = req.headers['x-yunus-token'];
    if (typeof provided !== 'string') return false;
    const providedBytes = Buffer.from(provided);
    return providedBytes.length === tokenBytes.length && timingSafeEqual(providedBytes, tokenBytes);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    let controller;
    try {
      if (!hosts.has(req.headers.host)) { send(403, { error: 'Invalid local host' }); return; }
      if ((req.headers.origin && !origins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') { send(403, { error: 'Cross-origin access is not allowed' }); return; }
      let pathname;
      try {
        const raw = (req.url || '/').split('?')[0], decoded = decodeURIComponent(raw);
        if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part.startsWith('.'))) { send(404, { error: 'Not found' }); return; }
        pathname = new URL(req.url, origin).pathname;
      } catch { send(400, { error: 'Invalid path' }); return; }
      if (['GET', 'HEAD'].includes(req.method) && pathname === '/api/health') { send(200, { ok: true, app: 'yunus-os-community', version }); return; }
      if (req.method === 'GET' && pathname === '/api/session') { send(200, { token }); return; }
      if (!pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) { send(405, { error: 'Method not allowed' }); return; }
        const file = files.get(pathname);
        if (!file) { send(404, { error: 'Not found' }); return; }
        send(200, await readFile(path.join(ROOT, file)), MIME[path.extname(file)]); return;
      }
      if (!authorized(req)) { send(401, { error: 'Open Yunus OS locally to start a session' }); return; }
      if (pathname === '/api/config' && req.method === 'GET') { send(200, { config: publicConfig(store.get()), capabilities: await capabilities() }); return; }
      if (pathname === '/api/config' && req.method === 'POST') {
        await store.save(await jsonBody(req)); assistant.cancel(); cancelVoice();
        send(200, { config: publicConfig(store.get()), capabilities: await capabilities() }); return;
      }
      if (pathname === '/api/all' && req.method === 'GET') { send(200, await dashboard.load()); return; }
      if (pathname === '/api/refresh' && req.method === 'POST') { await jsonBody(req); send(200, await dashboard.load(true)); return; }
      if (pathname === '/api/tasks' && req.method === 'POST') { send(201, { task: await store.updateTask(null, await jsonBody(req)) }); return; }
      if (/^\/api\/tasks\/[a-f0-9-]{36}$/.test(pathname) && ['PATCH', 'DELETE'].includes(req.method)) {
        const data = await jsonBody(req); const task = await store.updateTask(pathname.split('/').at(-1), data, req.method === 'DELETE'); send(200, { ok: true, task }); return;
      }
      if (pathname === '/api/assistant/cancel' && req.method === 'POST') {
        await jsonBody(req); for (const job of active) job.abort(); assistant.cancel(); cancelVoice(); send(200, { ok: true }); return;
      }
      if (pathname === '/api/assistant' && req.method === 'POST') {
        const data = await jsonBody(req);
        if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 4000) { send(400, { error: 'Write a request of up to 4,000 characters' }); return; }
        if (active.size) { send(409, { error: 'Wait for the current request or cancel it first' }); return; }
        controller = new AbortController(); active.add(controller);
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        send(200, await assistant.ask(data.message, { signal: controller.signal })); return;
      }
      if (pathname === '/api/transcribe' && req.method === 'POST') {
        if (req.headers['content-type']?.split(';')[0] !== 'audio/wav') { send(415, { error: 'Use audio/wav' }); return; }
        if (!store.get().voice.enabled) { send(403, { error: 'Enable local voice in Settings first' }); return; }
        if (active.size) { send(409, { error: 'A request is already running' }); return; }
        controller = new AbortController(); active.add(controller);
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        const wav = await body(req, 10 * 1024 * 1024);
        send(200, await transcribe(wav, store.get(), { signal: controller.signal })); return;
      }
      if (pathname === '/api/action' && req.method === 'POST') {
        const { action } = await jsonBody(req);
        if (action?.type === 'add_task') {
          const task = await store.updateTask(null, { title: action.title });
          send(201, { ok: true, task, message: 'Task added to your checklist' }); return;
        }
        if (process.platform !== 'darwin') { send(501, { error: 'Desktop app actions currently require macOS' }); return; }
        if (action?.type === 'open_app' && APPS.includes(action.app)) await exec('/usr/bin/open', ['-a', action.app], { timeout: 5000 });
        else if (action?.type === 'open_url') {
          let url; try { url = new URL(action.url); } catch { throw new Error('Invalid URL'); }
          if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2000) throw new Error('Only explicit HTTPS URLs can be opened');
          await exec('/usr/bin/open', [url.href], { timeout: 5000 });
        } else { send(400, { error: 'Unsupported desktop action' }); return; }
        send(200, { ok: true, message: 'Opened on your Mac' }); return;
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      const safe = error.code || /token|secret|authorization|bearer/i.test(error.message || '') ? 'Could not complete this request. Check your settings and try again.' : String(error.message || 'Request failed').slice(0, 240);
      send(error.status || (error.name === 'AbortError' ? 409 : 400), { error: safe });
    } finally { if (controller) active.delete(controller); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  origins = new Set([origin, `http://localhost:${server.address().port}`]);
  hosts = new Set([...origins].map(url => new URL(url).host));
  return { server, origin, close: async () => { for (const controller of active) controller.abort(); assistant.cancel(); cancelVoice(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.YOS_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('YOS_PORT must be a port number');
  const app = await createApp({ port });
  console.log(`Yunus OS: ${app.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
}
