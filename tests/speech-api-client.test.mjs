import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const freshClient = () => import(new URL(`../js/lib/api.js?test=${randomUUID()}`, import.meta.url));

test('speech success returns the audio blob without JSON parsing', async t => {
  const requests = [], bytes = new Uint8Array([73, 68, 51, 0, 1, 2]);
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    if (route === '/api/session') return Response.json({ token: 'fixture-session' });
    requests.push({ route, options });
    return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const client = await freshClient();
  const audio = await client.api('/api/speech', { method: 'POST', body: { text: 'The displayed reply.' }, responseType: 'blob' });
  assert.equal(audio.type, 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers['X-Yunus-Token'], 'fixture-session');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.equal(requests[0].options.body, '{"text":"The displayed reply."}');
});

test('an explicit pre-handler session expiry permits one speech retry with the same body', async t => {
  let sessions = 0, generations = 0;
  const requests = [], body = { text: 'Original displayed reply.' };
  t.mock.method(globalThis, 'fetch', async (route, options) => {
    if (route === '/api/session') return Response.json({ token: `session-${++sessions}` });
    requests.push(options);
    body.text = 'Modified later';
    if (requests.length === 1) return Response.json({ code: 'LOCAL_SESSION_EXPIRED', error: 'Session expired' }, { status: 401 });
    generations++;
    return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
  });
  const client = await freshClient();
  assert.equal((await client.api('/api/speech', { method: 'POST', body, responseType: 'blob' })).type, 'audio/mpeg');
  assert.equal(sessions, 2); assert.equal(generations, 1); assert.equal(requests.length, 2);
  assert.equal(requests[0].body, '{"text":"Original displayed reply."}');
  assert.equal(requests[1].body, requests[0].body);
});

test('provider and network failures are parsed as errors and never replay speech', async t => {
  let requests = 0, sessions = 0, failure;
  t.mock.method(globalThis, 'fetch', async route => {
    if (route === '/api/session') { sessions++; return Response.json({ token: 'session' }); }
    requests++;
    if (failure === 'network') throw new TypeError('Fixture connection lost');
    return Response.json({ error: 'Fixture provider failed' }, { status: failure });
  });
  const client = await freshClient();
  for (const problem of [401, 429, 502, 'network']) {
    failure = problem;
    await assert.rejects(client.api('/api/speech', { method: 'POST', body: { text: 'One attempt.' }, responseType: 'blob' }), /Fixture/);
  }
  assert.equal(requests, 4); assert.equal(sessions, 1);
});

test('a cancelled speech response cannot trigger a session renewal or generation replay', async t => {
  let requests = 0, sessions = 0;
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async route => {
    if (route === '/api/session') { sessions++; return Response.json({ token: 'session' }); }
    requests++; controller.abort();
    return Response.json({ code: 'LOCAL_SESSION_EXPIRED' }, { status: 401 });
  });
  const client = await freshClient();
  await assert.rejects(client.api('/api/speech', { method: 'POST', body: { text: 'Stopped.' }, signal: controller.signal, responseType: 'blob' }), { name: 'AbortError' });
  assert.equal(requests, 1); assert.equal(sessions, 1);
});
