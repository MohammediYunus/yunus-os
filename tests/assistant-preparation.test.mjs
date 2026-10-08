import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistant } from '../lib/assistant.mjs';
import { createApp } from '../server.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const stage of ['configuration', 'dashboard']) {
  for (const cancellation of ['cancel', 'caller', 'timeout']) {
    test(`${cancellation} stops a pending ${stage} read before it finishes`, async () => {
      const ready = deferred(), gate = deferred();
      const configuration = { assistant: { provider: 'ollama', model: 'fixture' } };
      const caller = new AbortController();
      let providerCalls = 0, dashboardCalls = 0;
      const hold = () => { ready.resolve(); return gate.promise; };
      const assistant = createAssistant({
        getConfig: stage === 'configuration' ? hold : () => configuration,
        getDashboard: () => { dashboardCalls++; return stage === 'dashboard' ? hold() : {}; },
        fetchImpl: () => { providerCalls++; throw new Error('Cancelled request must not start a provider'); },
        timeoutMs: cancellation === 'timeout' ? 20 : 2000,
      });
      const pending = assistant.ask('summary', { signal: caller.signal }).then(
        () => ({ status: 'resolved' }), error => ({ status: 'rejected', name: error.name }));
      try {
        await ready.promise;
        if (cancellation === 'cancel') assistant.cancel();
        if (cancellation === 'caller') caller.abort();
        const result = await Promise.race([pending, delay(250).then(() => ({ status: 'still waiting' }))]);
        assert.deepEqual(result, { status: 'rejected', name: 'AbortError' });
        assert.equal(providerCalls, 0);
        if (stage === 'configuration') assert.equal(dashboardCalls, 0);
      } finally {
        gate.resolve(stage === 'configuration' ? configuration : {});
        await pending;
      }
      // A result arriving after cancellation must not resume the abandoned request.
      await delay(0);
      assert.equal(providerCalls, 0);
      if (stage === 'configuration') assert.equal(dashboardCalls, 0);
    });
  }
}

test('late workspace failure is consumed after cancellation and a later request can succeed', async () => {
  const ready = deferred(), gate = deferred();
  let reads = 0;
  const assistant = createAssistant({
    getConfig: () => ({ assistant: { provider: 'local' } }),
    getDashboard: () => { if (++reads === 1) { ready.resolve(); return gate.promise; } return {}; },
  });
  const pending = assistant.ask('summary').then(() => 'resolved', error => error.name);
  try {
    await ready.promise;
    assistant.cancel();
    assert.equal(await Promise.race([pending, delay(250).then(() => 'still waiting')]), 'AbortError');
    assert.equal((await assistant.ask('summary')).provider, 'local');
  } finally {
    gate.reject(new Error('Connector failed after cancellation'));
    await pending;
  }
  await delay(0); // The test runner also rejects any unhandled rejection here.
});

test('cancelling one caller does not cancel the shared workspace read for another', async () => {
  const ready = deferred(), gate = deferred();
  let reads = 0;
  const assistant = createAssistant({
    getConfig: () => ({ assistant: { provider: 'local' } }),
    getDashboard: () => { if (++reads === 2) ready.resolve(); return gate.promise; },
  });
  const caller = new AbortController();
  const first = assistant.ask('summary', { signal: caller.signal }).then(() => 'resolved', error => error.name);
  const second = assistant.ask('summary');
  try {
    await ready.promise;
    caller.abort();
    assert.equal(await Promise.race([first, delay(250).then(() => 'still waiting')]), 'AbortError');
  } finally { gate.resolve({}); }
  assert.equal((await second).provider, 'local');
});

test('HTTP cancellation releases the assistant slot while a shared connector is still pending', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'yos-cancel-preparation-'));
  const ready = deferred(), gate = deferred(), retryReceived = deferred();
  let requests = 0;
  const app = await createApp({ configDir: profile, fetchImpl: async () => {
    ready.resolve(); await gate.promise;
    return { ok: true, json: async () => ({ items: [] }) };
  } });
  app.server.on('request', request => {
    if (request.url === '/api/assistant' && ++requests === 2) request.on('end', retryReceived.resolve);
  });
  let first, retry;
  try {
    const { token } = await (await fetch(`${app.origin}/api/session`)).json();
    const headers = { 'content-type': 'application/json', 'X-Yunus-Token': token, Origin: app.origin };
    const post = async (route, data) => {
      const response = await fetch(`${app.origin}${route}`, { method: 'POST', headers, body: JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await post('/api/config', { mode: 'live', github: { username: 'synthetic-cancellation', repositories: [] } })).status, 200);
    first = post('/api/assistant', { message: 'summary' });
    await ready.promise;
    assert.equal((await post('/api/assistant/cancel', {})).status, 200);
    const cancelled = await Promise.race([first, delay(250).then(() => ({ status: 'still waiting' }))]);
    assert.equal(cancelled.status, 409);

    retry = post('/api/assistant', { message: 'Add a task: review cancellation' });
    await retryReceived.promise;
    await nextTurn(); // Let the request's parsed-body continuation check its slot.
    gate.resolve();
    const result = await retry;
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.actions, [{ type: 'add_task', title: 'review cancellation' }]);
    const tasks = JSON.parse(await readFile(path.join(profile, 'tasks.json'), 'utf8'));
    assert.ok(!tasks.some(task => task.title === 'review cancellation'));
  } finally {
    gate.resolve();
    await Promise.allSettled([first, retry]);
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
