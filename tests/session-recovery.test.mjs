import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';

const freshClient = () => import(new URL(`../js/lib/api.js?test=${randomUUID()}`, import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'yos-session-test-'));
  const fetchImpl = () => { throw new Error('No external requests in this fixture'); };
  let app = await createApp({ configDir: profile, fetchImpl });
  const origin = app.origin, port = Number(new URL(origin).port);
  t.after(async () => { await app.close(); await rm(profile, { recursive: true, force: true }); });
  return {
    origin,
    tasks: async () => JSON.parse(await readFile(path.join(profile, 'tasks.json'), 'utf8')),
    restart: async () => { await app.close(); app = await createApp({ configDir: profile, port, fetchImpl }); },
  };
}

test('an open client recovers reads and one task write after a real server restart, including a late old 401', async t => {
  const server = await fixture(t), fetchLocal = globalThis.fetch, requests = [];
  const oldResponse = deferred(), releaseOld = deferred();
  t.after(() => releaseOld.resolve());
  let delayOld = false;
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    const response = await fetchLocal(new URL(route, server.origin), options);
    requests.push({ route, status: response.status });
    if (delayOld && route === '/api/config' && response.status === 401) {
      delayOld = false; oldResponse.resolve(); await releaseOld.promise;
    }
    return response;
  });
  const client = await freshClient();
  await client.api('/api/config');
  await server.restart();
  delayOld = true;
  const late = client.api('/api/config');
  late.catch(() => {}); // The baseline can reject during cleanup after another assertion fails.
  await oldResponse.promise;
  const [dashboard, task] = await Promise.all([
    client.api('/api/all'),
    client.api('/api/tasks', { method: 'POST', body: { title: 'Exactly one task after restart' } }),
  ]);
  releaseOld.resolve();
  assert.equal((await late).config.mode, 'demo');
  assert.equal(dashboard.mode, 'demo');
  assert.equal(task.task.title, 'Exactly one task after restart');
  assert.equal((await server.tasks()).filter(item => item.title === task.task.title).length, 1);
  assert.equal(requests.filter(item => item.route === '/api/session').length, 2, 'Initial handshake plus one shared renewal');
  assert.deepEqual(requests.filter(item => item.route === '/api/tasks').map(item => item.status), [401, 201]);
  await server.restart();
  assert.equal((await client.api('/api/config')).config.mode, 'demo');
  assert.equal(requests.filter(item => item.route === '/api/session').length, 3);
});

test('lost or unsuccessful responses after a task is saved never replay the write', async t => {
  const server = await fixture(t), fetchLocal = globalThis.fetch;
  let failure, writes = 0;
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    const response = await fetchLocal(new URL(route, server.origin), options);
    if (route === '/api/tasks') {
      writes++;
      assert.equal(response.status, 201, 'The real server completed the mutation');
      if (failure === 'network') throw new TypeError('Connection lost after write');
      return new Response(JSON.stringify({ error: 'Fixture upstream error' }), { status: failure });
    }
    return response;
  });
  const client = await freshClient();
  for (const problem of ['network', 500, 401, 403]) {
    failure = problem;
    await assert.rejects(client.api('/api/tasks', { method: 'POST', body: { title: `No replay ${problem}` } }));
  }
  assert.equal(writes, 4);
  assert.equal((await server.tasks()).filter(item => item.title.startsWith('No replay')).length, 4);
});

test('authentication renewal retries at most once and keeps the serialized request unchanged', async t => {
  let sessions = 0;
  const requests = [], body = { title: 'Original task' };
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    if (route === '/api/session') return Response.json({ token: `session-${++sessions}` });
    requests.push(options);
    body.title = 'Changed while the request was pending';
    return Response.json({ code: 'LOCAL_SESSION_EXPIRED', error: 'Session expired' }, { status: 401 });
  });
  const client = await freshClient();
  await assert.rejects(client.api('/api/tasks', { method: 'POST', body }), /Session expired/);
  assert.equal(sessions, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, '{"title":"Original task"}');
  assert.equal(requests[1].body, requests[0].body);
  assert.notEqual(requests[0].headers['X-Yunus-Token'], requests[1].headers['X-Yunus-Token']);
});

test('cancelling a rejected request does not start a renewal or replay it', async t => {
  let sessions = 0, requests = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async route => {
    if (route === '/api/session') { sessions++; return Response.json({ token: 'old-session' }); }
    requests++; controller.abort();
    return Response.json({ code: 'LOCAL_SESSION_EXPIRED', error: 'Session expired' }, { status: 401 });
  });
  const client = await freshClient();
  await assert.rejects(client.api('/api/tasks', { method: 'POST', body: { title: 'Cancelled task' }, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sessions, 1); assert.equal(requests, 1);
});

test('a failed renewal does not replay a write or prevent a later connection', async t => {
  let sessions = 0, requests = 0;
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    if (route === '/api/session') {
      sessions++;
      return sessions === 2 ? new Response('', { status: 503 }) : Response.json({ token: sessions === 1 ? 'old-session' : 'new-session' });
    }
    requests++;
    return options.headers['X-Yunus-Token'] === 'old-session'
      ? Response.json({ code: 'LOCAL_SESSION_EXPIRED', error: 'Session expired' }, { status: 401 })
      : Response.json({ ok: true });
  });
  const client = await freshClient();
  await assert.rejects(client.api('/api/tasks', { method: 'POST', body: { title: 'Not replayed' } }), /Could not connect/);
  assert.equal(sessions, 2); assert.equal(requests, 1);
  assert.equal((await client.api('/api/all')).ok, true);
  assert.equal(sessions, 3); assert.equal(requests, 2);
});

test('cancelling during a shared renewal prevents that replay while another request succeeds', { timeout: 2000 }, async t => {
  let sessions = 0;
  const requests = [], started = deferred(), release = deferred(), controller = new AbortController();
  t.after(() => release.resolve());
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    if (route === '/api/session') {
      sessions++;
      if (sessions === 2) { started.resolve(); await release.promise; }
      return Response.json({ token: sessions === 1 ? 'old-session' : 'new-session' });
    }
    requests.push({ route, token: options.headers['X-Yunus-Token'] });
    return options.headers['X-Yunus-Token'] === 'old-session'
      ? Response.json({ code: 'LOCAL_SESSION_EXPIRED', error: 'Session expired' }, { status: 401 })
      : Response.json({ ok: true });
  });
  const client = await freshClient();
  const cancelled = client.api('/api/tasks', { method: 'POST', body: { title: 'Cancelled during renewal' }, signal: controller.signal });
  cancelled.catch(() => {});
  await started.promise;
  const active = client.api('/api/all');
  controller.abort(); release.resolve();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await active).ok, true);
  assert.equal(sessions, 2);
  assert.equal(requests.filter(item => item.route === '/api/tasks').length, 1);
  assert.deepEqual(requests.filter(item => item.route === '/api/all'), [{ route: '/api/all', token: 'new-session' }]);
});
