import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
let temporary, configDir, auditFile, child, origin, port, sessionToken;
let output = '';

function request(route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { /* text response */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(8_000, () => req.destroy(new Error('Test HTTP request timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function authenticated(extra = {}) {
  return { 'X-Yunus-Token': sessionToken, Origin: origin, ...extra };
}

async function config() {
  const result = await request('/api/config', { headers: authenticated() });
  assert.equal(result.status, 200);
  return result.json.config ?? result.json;
}

before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'yunus-os-security-'));
  configDir = path.join(temporary, 'profile');
  auditFile = path.join(temporary, 'blocked-capabilities.jsonl');
  const home = path.join(temporary, 'empty-home');
  await mkdir(home);
  const guard = path.join(temporary, 'guard.mjs');
  // Audit attempted capabilities without sending any request or starting a provider.
  // Patching built-ins before app imports also covers named ESM imports.
  await writeFile(guard, `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const deny = name => (...args) => {
  fs.appendFileSync(process.env.YOS_SECURITY_AUDIT, JSON.stringify({ capability: name }) + '\\n');
  throw new Error('Security test blocked capability: ' + name);
};
globalThis.fetch = deny('fetch');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = deny(name);
net.Socket.prototype.connect = deny('outbound socket');
syncBuiltinESMExports();
`);
  // Do not inherit provider credentials or the developer's home/config paths.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    YOS_CONFIG_DIR: configDir, YOS_PORT: '0',
    YOS_SECURITY_AUDIT: auditFile,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: temporary, TMP: temporary } : {}),
  };
  child = spawn(process.execPath, ['--import', guard, 'server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start with clean HOME. ${output}`)), 12_000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', code => { if (!origin) fail(new Error(`Server exited ${code}. ${output}`)); });
    const collect = chunk => {
      output += chunk.toString();
      const match = output.match(/Yunus OS: (http:\/\/127\.0\.0\.1:(\d+))/);
      if (match && !origin) {
        origin = match[1]; port = Number(match[2]);
        clearTimeout(timeout); resolve();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
  });
  const session = await request('/api/session');
  assert.equal(session.status, 200);
  sessionToken = session.json.token;
  assert.equal(typeof sessionToken, 'string');
  assert.ok(sessionToken.length >= 32, 'Session token must be unpredictable');
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('fresh HOME starts a usable demo without credentials, network or subprocesses', async () => {
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.ok(!health.text.includes(configDir));
  const data = await request('/api/all', { headers: authenticated() });
  assert.equal(data.status, 200);
  assert.equal(data.json.demo, true);
  assert.equal(await readFile(auditFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }), '', 'Demo startup and reading must not attempt external activity');
});

test('hostile Host, Origin and cross-site requests cannot obtain a session', async () => {
  for (const headers of [
    { Host: 'attacker.example' },
    { Host: `127.0.0.1:${port}`, Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const result = await request('/api/session', { headers });
    assert.ok([400, 403].includes(result.status), JSON.stringify({ headers, status: result.status }));
    assert.ok(!result.text.includes(sessionToken));
  }
});

test('data, configuration and mutation routes require the session token', async () => {
  for (const route of ['/api/all', '/api/config']) {
    for (const token of [undefined, 'incorrect-token', 'é'.repeat(64)]) {
      const result = await request(route, { headers: token ? { 'X-Yunus-Token': token } : {} });
      assert.ok([401, 403].includes(result.status), `${route}: ${result.status}`);
    }
  }
  const mutation = await request('/api/tasks', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Unauthorized task' }),
  });
  assert.ok([401, 403].includes(mutation.status));
  const queryToken = await request(`/api/all?token=${encodeURIComponent(sessionToken)}`);
  assert.ok([401, 403].includes(queryToken.status), 'Tokens in URLs must not authenticate');
});

test('a valid token cannot authorize an untrusted browser origin', async () => {
  for (const Origin of ['https://attacker.example', 'null', `http://127.0.0.1:${port + 1}`]) {
    const result = await request('/api/config', {
      method: 'POST', headers: authenticated({ Origin, 'Content-Type': 'application/json' }), body: JSON.stringify({ displayName: 'Not permitted' }),
    });
    assert.equal(result.status, 403);
  }
});

test('JSON writes reject simple form content types', async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const result = await request('/api/config', {
      method: 'POST', headers: authenticated({ 'Content-Type': type }), body: JSON.stringify({ displayName: 'Not permitted' }),
    });
    assert.ok([400, 415].includes(result.status), `${type}: ${result.status}`);
  }
});

test('static delivery excludes source, config, runtime and traversal paths', async () => {
  for (const route of [
    '/server.mjs', '/package.json', '/README.md', '/.env', '/.git/config', '/lib/config.mjs',
    '/data/mail.json', '/data/voice/example.mp3', '/config.json', '/docs/implementation-contract.json',
    '/..%2fyunus-os-sibling/secret.txt', '/%2e%2e%2f.env', '/css/%2e%2e/server.mjs',
    '/%252e%252e%252f.env', '/css%5c..%5cserver.mjs', '/index.html%00', '/%zz',
  ]) {
    const result = await request(route, { headers: authenticated() });
    assert.ok([400, 403, 404].includes(result.status), `${route}: ${result.status}`);
    assert.ok(!result.text.includes(configDir));
    assert.ok(!result.text.includes(root));
  }
});

test('presentation has browser protections and no embedded session secret', async () => {
  const result = await request('/');
  assert.equal(result.status, 200);
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.match(result.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.match(result.headers['content-security-policy'] ?? '', /connect-src 'self'/);
  assert.ok(!result.text.includes(sessionToken));
});

test('invalid and oversized configuration writes preserve the saved profile', async () => {
  const original = await config();
  for (const body of ['{', JSON.stringify({ mode: 'not-a-mode' }), JSON.stringify({ workspacePaths: 'not-an-array' })]) {
    const result = await request('/api/config', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body,
    });
    assert.equal(result.status, 400);
    assert.deepEqual(await config(), original);
  }
  const oversized = await request('/api/config', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }), body: JSON.stringify({ displayName: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await config(), original);
});

test('saved credentials remain server-side, private on POSIX, and unused in demo', async () => {
  const fakeSecret = `security-test-placeholder-${randomUUID()}`;
  const written = await request('/api/config', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'demo', github: { token: fakeSecret } }),
  });
  assert.equal(written.status, 200);
  assert.ok(!written.text.includes(fakeSecret));
  const saved = await config();
  assert.equal(saved.github.hasToken, true);
  assert.ok(!JSON.stringify(saved).includes(fakeSecret));
  const data = await request('/api/all', { headers: authenticated() });
  assert.ok(!data.text.includes(fakeSecret));
  assert.ok(!output.includes(fakeSecret));
  assert.ok(!output.includes(sessionToken));
  const files = await readdir(configDir);
  assert.ok(files.length > 0, 'Saving configuration should persist a local file');
  if (process.platform !== 'win32') {
    assert.equal((await stat(configDir)).mode & 0o077, 0, 'Profile directory is accessible by other users');
    for (const name of files) {
      const info = await stat(path.join(configDir, name));
      if (info.isFile()) assert.equal(info.mode & 0o077, 0, `${name} is accessible by other users`);
    }
  }
  assert.equal(await readFile(auditFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  }), '', 'Saving a credential in demo must not connect or start a provider');
  const keep = await request('/api/config', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ github: { token: '' } }),
  });
  assert.equal(keep.status, 200);
  assert.equal((await config()).github.hasToken, true);
  assert.equal(JSON.parse(await readFile(path.join(configDir, 'config.json'), 'utf8')).github.token, fakeSecret);
  const clear = await request('/api/config', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ github: { clearToken: true } }),
  });
  assert.equal(clear.status, 200);
  assert.equal((await config()).github.hasToken, false);
  assert.equal(JSON.parse(await readFile(path.join(configDir, 'config.json'), 'utf8')).github.token, '');
});

test('voice upload enforces the same 10 MiB limit as the transcriber before processing', async () => {
  const enabled = await request('/api/config', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ voice: { enabled: true, whisperExecutable: 'yunus-security-missing-whisper' } }),
  });
  assert.equal(enabled.status, 200);
  try {
    const oversized = await request('/api/transcribe', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'audio/wav' }),
      body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await request('/api/config', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ voice: { enabled: false } }),
    });
  }
});

test('an in-progress voice upload reserves the active request slot', async () => {
  await request('/api/config', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ voice: { enabled: true, whisperExecutable: 'yunus-security-missing-whisper' } }),
  });
  let upload;
  let resolveResponse;
  const responseDone = new Promise(resolve => { resolveResponse = resolve; });
  try {
    await new Promise((resolve, reject) => {
      upload = http.request({ host: '127.0.0.1', port, path: '/api/transcribe', method: 'POST',
        headers: authenticated({ 'Content-Type': 'audio/wav', 'Content-Length': '44', Expect: '100-continue' }),
      }, res => { res.resume(); res.once('end', resolveResponse); });
      upload.setTimeout(8_000, () => upload.destroy(new Error('Test upload timed out')));
      upload.on('error', error => { reject(error); resolveResponse(); });
      upload.once('continue', resolve);
      upload.flushHeaders();
    });
    const second = await request('/api/assistant', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: 'Summarize the workspace' }),
    });
    assert.equal(second.status, 409);
  } finally {
    upload?.end(Buffer.alloc(44));
    await responseDone;
    await request('/api/config', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ voice: { enabled: false } }),
    });
  }
});

test('assistant task creation remains a proposal until approved, then persists locally', async () => {
  const title = 'Review the release checklist';
  const before = JSON.parse(await readFile(path.join(configDir, 'tasks.json'), 'utf8'));
  const proposal = await request('/api/assistant', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message: `Add a task: ${title}` }),
  });
  assert.equal(proposal.status, 200);
  assert.deepEqual(proposal.json.actions, [{ type: 'add_task', title }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(configDir, 'tasks.json'), 'utf8')), before, 'The assistant must not save its proposal');
  const approved = await request('/api/action', {
    method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: proposal.json.actions[0] }),
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.json.ok, true);
  assert.equal(approved.json.task.title, title);
  const persisted = JSON.parse(await readFile(path.join(configDir, 'tasks.json'), 'utf8'));
  assert.equal(persisted.length, before.length + 1);
  assert.equal(persisted.at(-1).id, approved.json.task.id);
  const dashboard = await request('/api/all', { headers: authenticated() });
  assert.ok(dashboard.json.tasks.items.some(item => item.id === approved.json.task.id));
});

test('configuring an optional provider does not run it or contact a service', async () => {
  try {
    const saved = await request('/api/config', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ assistant: { provider: 'claude', executable: process.execPath } }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await config()).assistant.provider, 'claude');
    assert.equal(await readFile(auditFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }), '', 'Checking provider installation must not run or authenticate it');
  } finally {
    await request('/api/config', {
      method: 'POST', headers: authenticated({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ assistant: { provider: 'local', executable: 'claude' } }),
    });
  }
});
