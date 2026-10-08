import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../lib/config.mjs';
import { createDashboard } from '../lib/connectors.mjs';
import { workspaceSummary } from '../js/lib/local-commands.js';

function fixture(t, { empty = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T16:00:00.000Z') });
  const config = defaults(); config.mode = 'live';
  config.github = { username: 'alice', repositories: ['alice/orbit'], token: 'fixture-secret' };
  const tasks = [], calls = [];
  let failed = false, title = 'Original pull request', gate = null;
  const issue = () => ({ repository_url: 'https://api.github.com/repos/alice/orbit', number: 3, title,
    created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-08T10:00:00Z', html_url: 'https://github.com/alice/orbit/pull/3' });
  const fetchImpl = async url => {
    calls.push(url);
    // Capture the request's outcome before waiting, as for an in-flight response.
    const reject = failed, current = issue(), pending = gate;
    if (pending) await pending.promise;
    if (reject) return { ok: false, status: 401, json: async () => ({ message: 'fixture-private-body' }) };
    return { ok: true, json: async () => url.includes('/actions/runs')
      ? { workflow_runs: empty ? [] : [{ name: 'CI', head_branch: 'main', conclusion: 'failure', status: 'completed', updated_at: current.updated_at, html_url: 'https://github.com/alice/orbit/actions/runs/5' }] }
      : { items: empty ? [] : [current] } };
  };
  const board = createDashboard({ store: { get: () => structuredClone(config), tasks: () => structuredClone(tasks) }, fetchImpl,
    execImpl: () => { throw new Error('No subprocess is allowed in this synthetic GitHub fixture'); } });
  return { board, config, tasks, calls, tick: () => t.mock.timers.tick(1000), fail: () => { failed = true; },
    recover: () => { failed = false; title = 'Recovered pull request'; },
    delay: () => { let resolve; const promise = new Promise(done => { resolve = done; }); gate = { promise, resolve }; return gate; },
    release: pending => { gate = null; pending.resolve(); } };
}

test('GitHub success, failure and recovery preserve the last successful timestamp', async t => {
  const f = fixture(t), first = await f.board.load();
  assert.equal(first.sources.github.status, 'live');
  f.tick(); f.fail(); const failed = await f.board.load(true);
  assert.deepEqual(failed.github, first.github);
  assert.equal(first.sources.github.stale, false);
  assert.equal(first.sources.github.updatedAt, first.github.fetchedAt);
  assert.equal(failed.sources.github.status, 'error');
  assert.equal(failed.sources.github.stale, true);
  assert.equal(failed.sources.github.updatedAt, first.github.fetchedAt);
  assert.notEqual(failed.fetchedAt, first.fetchedAt);
  assert.match(failed.sources.github.message, /rejected the token/);
  assert.doesNotMatch(JSON.stringify(failed), /fixture-secret|fixture-private-body/);
  f.tick(); f.recover(); const recovered = await f.board.load(true);
  assert.equal(recovered.github.myOpenPRs[0].title, 'Recovered pull request');
  assert.notEqual(recovered.github.fetchedAt, first.github.fetchedAt);
  assert.equal(recovered.sources.github.status, 'live');
  assert.equal(recovered.sources.github.stale, false);
  assert.equal(recovered.sources.github.updatedAt, recovered.github.fetchedAt);
});

test('returned successful, stale and TTL-cached snapshots cannot mutate retained data', async t => {
  const f = fixture(t), first = await f.board.load(), original = structuredClone(first.github);
  first.github.myOpenPRs[0].title = 'Caller mutation'; first.sources.github.updatedAt = 'caller date';
  f.fail(); const stale = await f.board.load(true);
  assert.deepEqual(stale.github, original);
  stale.github.myOpenPRs[0].title = 'Stale caller mutation'; stale.github.recentRuns.length = 0;
  const cached = await f.board.load(); assert.deepEqual(cached.github, original);
  cached.github.myOpenPRs.length = 0;
  const again = await f.board.load(true); assert.deepEqual(again.github, original);
  assert.equal(again.sources.github.updatedAt, original.fetchedAt);
});

test('a first GitHub failure has no fabricated snapshot or success timestamp', async t => {
  const f = fixture(t); f.fail(); const value = await f.board.load();
  assert.equal(value.github, null);
  assert.equal(value.sources.github.status, 'error');
  assert.equal(value.sources.github.stale, false);
  assert.equal(value.sources.github.updatedAt, undefined);
});

test('a successful empty GitHub result is retained on failure', async t => {
  const f = fixture(t, { empty: true }), first = await f.board.load();
  assert.deepEqual(first.github.myOpenPRs, []);
  f.fail(); const value = await f.board.load(true);
  assert.deepEqual(value.github, first.github);
  assert.equal(value.sources.github.stale, true);
  assert.equal(value.sources.github.updatedAt, first.github.fetchedAt);
});

test('GitHub identity changes invalidate the retained snapshot inside the TTL window', async t => {
  for (const [name, change] of [
    ['username', config => { config.github.username = 'bob'; }],
    ['token', config => { config.github.token = 'different-fixture-secret'; }],
    ['repositories', config => { config.github.repositories = ['alice/other']; }],
  ]) {
    await t.test(name, async child => {
      const f = fixture(child); await f.board.load(); f.fail(); change(f.config);
      const value = await f.board.load();
      assert.equal(value.github, null);
      assert.equal(value.sources.github.status, 'error');
      assert.equal(value.sources.github.stale, false);
      assert.equal(value.sources.github.updatedAt, undefined);
    });
  }
});

test('disconnect and demo mode clear live retention even when the old profile returns', async t => {
  for (const mode of ['disconnected', 'demo']) {
    await t.test(mode, async child => {
      const f = fixture(child), original = structuredClone(f.config.github);
      await f.board.load();
      if (mode === 'demo') f.config.mode = 'demo';
      else f.config.github = { username: '', repositories: [], token: '' };
      const changed = await f.board.load();
      assert.equal(changed.sources.github.status, mode === 'demo' ? 'demo' : 'disabled');
      f.config.mode = 'live'; f.config.github = original; f.fail();
      const returned = await f.board.load();
      assert.equal(returned.github, null);
      assert.equal(returned.sources.github.status, 'error');
      assert.equal(returned.sources.github.stale, false);
    });
  }
});

test('a late account A success cannot seed account B while B waits for refresh', async t => {
  const f = fixture(t), pending = f.delay(), firstLoad = f.board.load();
  await Promise.resolve(); f.config.github.username = 'bob'; f.fail();
  const secondLoad = f.board.load(); f.release(pending);
  await firstLoad; const value = await secondLoad;
  assert.equal(value.github, null);
  assert.equal(value.sources.github.status, 'error');
  assert.equal(value.sources.github.stale, false);
  f.config.github.username = 'alice'; const returned = await f.board.load();
  assert.equal(returned.github, null, 'A late result must not survive observed identity changes');
});

test('changing identity away and back during an in-flight refresh invalidates its retention', async t => {
  const f = fixture(t), pending = f.delay(), originalLoad = f.board.load();
  await Promise.resolve(); f.config.github.username = 'bob'; f.fail(); const bobLoad = f.board.load();
  f.config.github.username = 'alice'; const aliceLoad = f.board.load(true); f.release(pending);
  await Promise.all([originalLoad, bobLoad]); const value = await aliceLoad;
  assert.equal(value.github, null, 'The pre-change A request must not re-seed A after returning');
  assert.equal(value.sources.github.stale, false);
});

test('stale GitHub does not become fresh activity or current summary claims while local tasks update', async t => {
  const f = fixture(t); await f.board.load(); f.fail();
  f.tasks.push({ id: 'local-task', title: 'Task created offline', done: false, createdAt: new Date().toISOString() });
  const value = await f.board.load(true);
  assert.equal(value.sources.github.stale, true);
  assert.deepEqual(value.news.items.map(item => item.source), ['local']);
  assert.equal(value.tasks.items[0].title, 'Task created offline');
  const summary = workspaceSummary(value);
  assert.match(summary, /GitHub unavailable/);
  assert.match(summary, /Task created offline/);
  assert.doesNotMatch(summary, /open pull requests|reviews requested|Pull request: Original/);
});
