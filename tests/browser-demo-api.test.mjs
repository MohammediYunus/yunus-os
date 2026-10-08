import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from '../js/demo/api.js';
import { localAnswer } from '../js/lib/local-commands.js';

const instant = '2026-10-08T10:00:00.000Z';
function storageWith(raw = null) {
  const values = new Map(raw === null ? [] : [['test-demo', raw]]), reads = [], writes = [];
  return {
    values, reads, writes,
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push([key, value]); values.set(key, value); },
  };
}
function setup(options = {}) {
  let next = 0;
  return createDemoApi({ storageKey: 'test-demo', now: () => new Date(instant), uuid: () => `new-${++next}`, ...options });
}
const post = (api, path, body) => api(path, { method: 'POST', body });

test('demo runs without a session or network and advertises its actual capabilities', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('demo must not fetch'); });
  const { api, connectSession } = setup();
  await connectSession();
  const { config, capabilities } = await api('/api/config');
  assert.equal(config.mode, 'demo');
  assert.equal(config.displayName, 'Browser demo');
  assert.deepEqual(config.workspacePaths, []);
  assert.deepEqual(config.github, { username: '', repositories: [], hasToken: false });
  assert.deepEqual(config.assistant, { provider: 'local' });
  assert.equal(capabilities.runtime, 'browser-demo');
  assert.equal(capabilities.connections.available, false);
  assert.equal(capabilities.desktop.available, false);
  assert.equal(capabilities.voice.inputSupported, false);
  assert.equal(capabilities.assistant.mode, 'deterministic');
  assert.equal(capabilities.storage.persistent, false);
  const data = await api('/api/all');
  assert.equal(data.demo, true);
  assert.equal(data.runtime.connectedSources, 0);
  assert.match(data.disclosure, /Sample graph.*No connected accounts/);
  assert.match(data.storage.message, /lost on reload/);
  assert.match((await post(api, '/api/assistant', { message: 'hello' })).text, /do not use a model/);
  await post(api, '/api/refresh');
  assert.deepEqual(await post(api, '/api/assistant/cancel'), { ok: true });
  assert.equal(fetch.mock.callCount(), 0);
});

test('refresh retains task identity and fixture content while returned data is isolated', async () => {
  let clock = new Date(instant);
  const { api } = setup({ now: () => clock });
  const first = await api('/api/all');
  clock = new Date(clock.getTime() + 60_000);
  const refreshed = await post(api, '/api/refresh');
  assert.notEqual(refreshed.fetchedAt, first.fetchedAt);
  for (const key of ['graph', 'github', 'repos', 'news']) assert.deepEqual(refreshed[key], first[key]);
  assert.deepEqual(refreshed.tasks.items, first.tasks.items);
  first.tasks.items[0].title = 'mutated outside adapter';
  first.graph.nodes.length = 0;
  const { config } = await api('/api/config');
  config.assistant.provider = 'remote';
  const after = await api('/api/all');
  assert.notEqual(after.tasks.items[0].title, first.tasks.items[0].title);
  assert.ok(after.graph.nodes.length > 0);
  assert.equal((await api('/api/config')).config.assistant.provider, 'local');
});

test('task mutations update checklist and summaries, persist, and survive a new adapter', async () => {
  const storage = storageWith(), { api } = setup({ storage });
  const before = await api('/api/all');
  const { task } = await post(api, '/api/tasks', { title: '  Review browser demo  ' });
  assert.deepEqual(task, { id: 'new-1', title: 'Review browser demo', done: false, createdAt: instant });
  task.title = 'outside mutation';
  const added = await api('/api/all');
  assert.equal(added.tasks.items.at(-1).title, 'Review browser demo');
  assert.equal(added.initiative.checklist.total, before.tasks.items.length + 1);
  assert.match((await post(api, '/api/assistant', { message: 'summary' })).text, /Task: Review browser demo/);
  const completed = await api('/api/tasks/new-1', { method: 'PATCH', body: { done: true } });
  assert.equal(completed.task.done, true);
  assert.equal((await api('/api/all')).initiative.checklist.done, before.initiative.checklist.done + 1);
  assert.doesNotMatch((await post(api, '/api/assistant', { message: 'summary' })).text, /Task: Review browser demo/);
  await post(api, '/api/config', { voice: { enabled: true } });
  const restored = setup({ storage });
  assert.equal((await restored.api('/api/all')).tasks.items.at(-1).done, true);
  assert.equal((await restored.api('/api/config')).config.voice.enabled, true);
  assert.equal((await restored.api('/api/config')).capabilities.voice.inputSupported, false);
  assert.deepEqual(await restored.api('/api/tasks/new-1', { method: 'DELETE' }), { ok: true, task: null });
  assert.equal((await restored.api('/api/all')).tasks.items.length, before.tasks.items.length);
  const saved = JSON.parse(storage.values.get('test-demo'));
  assert.deepEqual(Object.keys(saved).sort(), ['tasks', 'version', 'voice']);
  assert.ok(storage.reads.every(key => key === 'test-demo'));
  assert.ok(storage.writes.every(([key]) => key === 'test-demo'));
});

test('assistant task proposals wait for approval; browser actions cannot open apps or links', async () => {
  const { api } = setup(), before = (await api('/api/all')).tasks.items.length;
  const answer = await post(api, '/api/assistant', { message: 'Add a task: Check keyboard navigation' });
  assert.deepEqual(answer.actions, [{ type: 'add_task', title: 'Check keyboard navigation' }]);
  assert.equal((await api('/api/all')).tasks.items.length, before);
  await post(api, '/api/action', { action: answer.actions[0] });
  assert.equal((await api('/api/all')).tasks.items.at(-1).title, 'Check keyboard navigation');
  for (const message of ['open Calculator', 'open https://example.com/']) {
    const blocked = await post(api, '/api/assistant', { message });
    assert.equal(blocked.actions, undefined);
    assert.match(blocked.text, /cannot open apps or websites/);
    assert.ok(localAnswer(message, {}).actions, 'local server retains its approved-action behavior');
  }
  for (const action of [{ type: 'open_app', app: 'Calculator' }, { type: 'open_url', url: 'https://example.com/' }, { type: 'shell', command: 'echo nope' }, { type: 'add_task', title: 'task', command: 'nope' }]) {
    await assert.rejects(post(api, '/api/action', { action }), /Only checklist tasks/);
  }
  assert.equal((await api('/api/all')).tasks.items.length, before + 1);
});

test('two open tabs read current tasks and preserve each other’s task and speech edits', async () => {
  const storage = storageWith();
  const tabA = setup({ storage, uuid: () => 'tab-a' });
  const tabB = setup({ storage, uuid: () => 'tab-b' });
  const writesAfterInit = storage.writes.length;
  await post(tabA.api, '/api/tasks', { title: 'Task from A' });
  await post(tabB.api, '/api/tasks', { title: 'Task from B' });
  assert.deepEqual((await post(tabA.api, '/api/refresh')).tasks.items.slice(-2).map(task => task.id), ['tab-a', 'tab-b']);
  assert.equal(writesAfterInit, 1, 'opening another tab must not rewrite existing saved state');
  await tabA.api('/api/tasks/tab-b', { method: 'PATCH', body: { done: true } });
  await post(tabB.api, '/api/config', { voice: { enabled: true } });
  assert.equal((await tabA.api('/api/config')).config.voice.enabled, true);
  assert.equal((await tabB.api('/api/all')).tasks.items.find(task => task.id === 'tab-b').done, true);
  await tabA.api('/api/tasks/tab-a', { method: 'DELETE' });
  assert.doesNotMatch((await post(tabB.api, '/api/assistant', { message: 'summary' })).text, /Task: Task from A/);
  const reload = setup({ storage });
  const reloaded = await reload.api('/api/all');
  assert.equal(reloaded.tasks.items.find(task => task.id === 'tab-a'), undefined);
  assert.equal(reloaded.tasks.items.find(task => task.id === 'tab-b').done, true);
  assert.equal((await reload.api('/api/config')).config.voice.enabled, true);
  assert.equal(storage.writes.length, 6, 'reads and reloads must not write to storage');
});

test('config rejects credentials, live connections and unknown fields without storing them', async () => {
  const storage = storageWith(), { api } = setup({ storage }), saved = storage.values.get('test-demo');
  for (const body of [
    {}, null, [], { mode: 'live' }, { workspacePaths: ['/tmp/project'] },
    { github: { token: 'secret-that-must-not-be-stored' } }, { assistant: { provider: 'claude' } },
    { voice: { enabled: true, endpoint: 'https://example.com' } }, { voice: { enabled: 'yes' } },
    { voice: { enabled: true }, token: 'secret-that-must-not-be-stored' },
  ]) await assert.rejects(post(api, '/api/config', body), /only saves the spoken-reply preference/);
  assert.equal(storage.values.get('test-demo'), saved);
  assert.equal((await api('/api/config')).config.voice.enabled, false);
});

test('invalid mutations, duplicate IDs, unknown routes and cancelled requests cannot change tasks', async () => {
  const storage = storageWith(), { api } = setup({ storage, uuid: () => 'demo-task-0' });
  const before = await api('/api/all'), saved = storage.values.get('test-demo');
  for (const title of ['', '   ', 12, null, 'a'.repeat(241), 'line\nbreak', 'bad\u0000title']) {
    await assert.rejects(post(api, '/api/tasks', { title }), /Give the task a title/);
  }
  await assert.rejects(post(api, '/api/tasks', { title: 'valid' }), /unique task/);
  await assert.rejects(post(api, '/api/tasks', { title: 'valid', token: 'nope' }), /Only a task title/);
  for (const body of [{ done: 1 }, { done: false, title: 'changed' }, {}]) {
    await assert.rejects(api('/api/tasks/demo-task-0', { method: 'PATCH', body }), /state must be/);
  }
  for (const path of ['/api/tasks/missing', '/api/tasks/%bad']) await assert.rejects(api(path, { method: 'DELETE' }), /Task not found/);
  for (const path of ['/api/session', '/api/transcribe', '/api/desktop', 'https://example.com/api/tasks']) await assert.rejects(post(api, path, {}), /not available/);
  await assert.rejects(api('/api/tasks/demo-task-0', { method: 'PUT', body: { done: true } }), /not available/);
  await assert.rejects(post(api, '/api/assistant', { message: '  ' }), /Write a request/);
  await assert.rejects(post(api, '/api/assistant', { message: 'a'.repeat(4001) }), /Write a request/);
  await assert.rejects(post(api, '/api/assistant', { message: 'summary', provider: 'claude' }), /Write a request/);
  await assert.rejects(api('/api/tasks', { method: 'POST', binary: true, body: 'bytes' }), /require the local app/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api('/api/tasks/demo-task-0', { method: 'DELETE', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual((await api('/api/all')).tasks.items, before.tasks.items);
  assert.equal(storage.values.get('test-demo'), saved);
});

test('malformed or unsupported saved data is discarded rather than partially trusted', async () => {
  const clean = storageWith(); setup({ storage: clean });
  const valid = JSON.parse(clean.values.get('test-demo'));
  const invalid = [
    'not json', 'x'.repeat(256 * 1024 + 1), JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, token: 'secret-that-must-not-be-returned' }),
    JSON.stringify({ ...valid, tasks: [valid.tasks[0], valid.tasks[0]] }),
    JSON.stringify({ ...valid, tasks: [{ ...valid.tasks[0], createdAt: 'not a date' }] }),
    JSON.stringify({ ...valid, tasks: [{ ...valid.tasks[0], title: 'bad\nvalue' }] }),
    JSON.stringify({ ...valid, tasks: [{ ...valid.tasks[0], path: '/not-a-project' }] }),
    JSON.stringify({ ...valid, voice: { enabled: 'true' } }),
  ];
  for (const raw of invalid) {
    const storage = storageWith(raw), { api } = setup({ storage }), data = await api('/api/all');
    assert.deepEqual(data.tasks.items, valid.tasks);
    assert.equal(data.storage.persistent, true);
    assert.match(data.storage.message, /invalid.*last valid tasks.*only in this browser/);
    assert.doesNotMatch(JSON.stringify(data), /secret-that-must-not-be-returned/);
    assert.equal(storage.values.get('test-demo'), raw, 'reading invalid state must not rewrite storage');
    assert.equal(storage.writes.length, 0);
    await post(api, '/api/tasks', { title: 'Recover with a valid task' });
    const recovered = JSON.parse(storage.values.get('test-demo'));
    assert.deepEqual(recovered.tasks.slice(0, -1), valid.tasks);
    assert.equal(recovered.tasks.at(-1).title, 'Recover with a valid task');
    assert.deepEqual(Object.keys(recovered).sort(), ['tasks', 'version', 'voice']);
  }
});

test('unavailable storage and later quota failures preserve working session data with an honest disclosure', async () => {
  for (const storage of [null, { getItem() { throw new Error('denied'); } }, { getItem() { return null; }, setItem() { throw new Error('quota'); } }]) {
    const { api } = setup({ storage });
    await post(api, '/api/tasks', { title: 'Works in memory' });
    const data = await api('/api/all');
    assert.equal(data.tasks.items.at(-1).title, 'Works in memory');
    assert.equal(data.storage.persistent, false);
    assert.match(data.storage.message, /lost on reload/);
    assert.equal((await api('/api/config')).capabilities.storage.persistent, false);
  }
  const storage = storageWith(), { api } = setup({ storage }), saved = storage.values.get('test-demo');
  storage.setItem = () => { throw new Error('quota now full'); };
  await post(api, '/api/tasks', { title: 'Keep this session working' });
  const data = await api('/api/all');
  assert.equal(data.tasks.items.at(-1).title, 'Keep this session working');
  assert.equal(data.storage.persistent, false);
  assert.match(data.disclosure, /Further edits.*lost on reload/);
  assert.equal(storage.values.get('test-demo'), saved);
});

test('storage is project-scoped and task growth is bounded', async () => {
  const storage = storageWith();
  createDemoApi({ storage });
  const expectedKey = `yunus-os:browser-demo:v1:${new URL('../', import.meta.url).pathname}`;
  assert.deepEqual(storage.reads, [expectedKey]);
  assert.equal(storage.writes[0][0], expectedKey);
  const state = { version: 1, voice: { enabled: false }, tasks: Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, title: 'Task', done: false, createdAt: instant })) };
  const full = storageWith(JSON.stringify(state)), { api } = setup({ storage: full });
  await assert.rejects(post(api, '/api/tasks', { title: 'One too many' }), /list is full/);
  await assert.rejects(post(api, '/api/action', { action: { type: 'add_task', title: 'One too many' } }), /list is full/);
  assert.equal((await api('/api/all')).tasks.items.length, 200);
  state.tasks.push({ ...state.tasks[0], id: 'overflow' });
  const invalid = setup({ storage: storageWith(JSON.stringify(state)) });
  assert.ok((await invalid.api('/api/all')).tasks.items.length < 200);
});
