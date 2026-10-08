import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore, defaults, publicConfig, validateConfig } from '../lib/config.mjs';

async function temporary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yos-config-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('configuration persists privately and public responses redact tokens without shared references', async () => {
  await temporary(async directory => {
    const store = await createConfigStore(directory);
    const publicValue = await store.save({ mode: 'live', displayName: 'Orbit', github: { username: 'alice', repositories: ['alice/orbit'], token: 'fixture-secret' } });
    assert.equal(publicValue.github.hasToken, true);
    assert.equal('token' in publicValue.github, false);
    assert.doesNotMatch(JSON.stringify(publicValue), /fixture-secret/);
    publicValue.github.repositories.push('attacker/modified');
    assert.deepEqual(store.get().github.repositories, ['alice/orbit']);
    const second = await createConfigStore(directory);
    assert.equal(second.get().github.token, 'fixture-secret');
    assert.equal(second.get().displayName, 'Orbit');
    if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'config.json'))).mode & 0o777, 0o600);
  });
});

test('blank token keeps credential, explicit clear wins, and invalid patches never replace saved settings', async () => {
  await temporary(async directory => {
    const store = await createConfigStore(directory);
    await store.save({ github: { token: 'fixture-secret' } });
    await store.save({ github: { token: '   ' } });
    assert.equal(store.get().github.token, 'fixture-secret');
    await assert.rejects(store.save({ github: { clearToken: 'true' } }), /clear token/);
    await assert.rejects(store.save({ workspacePaths: ['relative/path'] }), /absolute/);
    assert.equal(store.get().github.token, 'fixture-secret');
    await store.save({ github: { token: 'old-form-value', clearToken: true } });
    assert.equal(store.get().github.token, '');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'config.json'))).github.token, '');
  });
});

test('settings reject invalid types, remote provider endpoints and control characters', () => {
  for (const value of [null, [], 'text']) assert.throws(() => validateConfig(value), /object/);
  for (const value of [
    { mode: 'anything' }, { displayName: 'name\nheader' }, { timezone: 'not/a/timezone' },
    { github: { username: '-alice' } }, { github: { repositories: ['https://github.com/a/b'] } },
    { github: { token: null } }, { voice: { enabled: 'yes' } },
    { assistant: { endpoint: 'https://example.com' } }, { assistant: { endpoint: 'http://user:pass@127.0.0.1:11434' } },
    { assistant: { endpoint: 'http://localhost:11434/api/generate' } },
  ]) assert.throws(() => validateConfig(value));
  const config = defaults();
  const exposed = publicConfig(config); exposed.workspacePaths.push('/not-the-original');
  assert.deepEqual(config.workspacePaths, []);
});

test('serialized task and config updates survive restart without dropping concurrent writes', async () => {
  await temporary(async directory => {
    const store = await createConfigStore(directory);
    const [first, second] = await Promise.all([store.updateTask(null, { title: 'Ship release' }), store.updateTask(null, { title: 'Review docs' })]);
    await Promise.all([store.save({ displayName: 'Orbit' }), store.save({ timezone: 'UTC' }), store.updateTask(first.id, { done: true })]);
    assert.equal(store.get().displayName, 'Orbit'); assert.equal(store.get().timezone, 'UTC');
    await assert.rejects(store.updateTask(first.id, { done: 'true' }), /true or false/);
    await assert.rejects(store.updateTask(null, null), /JSON object/);
    await assert.rejects(store.updateTask(null, { title: '  ' }), /title/);
    await store.updateTask(second.id, null, true);
    const reopened = await createConfigStore(directory);
    assert.equal(reopened.tasks().find(item => item.id === first.id).done, true);
    assert.equal(reopened.tasks().find(item => item.id === second.id), undefined);
    const snapshot = reopened.tasks(); snapshot[0].title = 'mutated';
    assert.notEqual(reopened.tasks()[0].title, 'mutated');
  });
});

test('malformed persisted task entries fail instead of becoming fictitious default tasks', async () => {
  for (const contents of [null, [{ id: 'a', title: 'Task', done: 'yes', createdAt: new Date().toISOString() }], [{ id: 'a', title: 'Task', done: false, createdAt: 'not-a-date' }]]) {
    await temporary(async directory => {
      await writeFile(path.join(directory, 'tasks.json'), JSON.stringify(contents));
      await assert.rejects(createConfigStore(directory), /Invalid local task/);
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'tasks.json'), 'utf8')), contents);
    });
  }
});

test('symlinked config file is rejected without overwriting its target', async t => {
  if (process.platform === 'win32') return t.skip('Symlink privilege varies on Windows; file permissions are covered separately');
  await temporary(async directory => {
    const target = path.join(directory, 'outside.json');
    await writeFile(target, JSON.stringify(defaults()));
    await symlink(target, path.join(directory, 'config.json'));
    await assert.rejects(createConfigStore(directory), /symlinks/);
    assert.deepEqual(JSON.parse(await readFile(target)), defaults());
  });
});
