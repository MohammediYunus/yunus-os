import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from '../lib/config.mjs';
import { createDashboard } from '../lib/connectors.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yos-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project with spaces'), child = path.join(root, 'src');
  const plain = path.join(base, 'plain'), file = path.join(base, 'file.txt'), missing = path.join(base, 'missing');
  for (const dir of [root, child, plain]) await mkdir(dir, { recursive: true });
  await writeFile(file, 'fixture'); await writeFile(path.join(root, 'index.js'), 'export {};');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  await exec('git', ['-c', 'core.hooksPath=/nonexistent-yos-test-hooks', '-c', 'core.fsmonitor=false', '-C', root, 'init', '-b', 'main'], { env });
  const store = await createConfigStore(path.join(base, 'profile'));
  const execute = (command, args, options) => exec(command, args, { ...options, env });
  const board = createDashboard({ store, execImpl: execute, fetchImpl: () => { throw new Error('Unexpected network request'); } });
  const load = async paths => { await store.save({ mode: 'live', workspacePaths: paths }); return board.load(true); };
  return { root, child, plain, file, missing, store, load };
}

for (const [field, code, wording] of [
  ['missing', 'path-missing', /does not exist/i],
  ['file', 'not-folder', /choose a folder/i],
  ['plain', 'not-repository', /Git repository/i],
  ['child', 'not-root', /root folder/i],
]) test(`repository setup explains ${field} after saving configuration`, async t => {
  const f = await fixture(t), value = await f.load([f[field]]);
  assert.equal(value.sources.repos.status, 'error');
  const [problem] = value.sources.repos.problems;
  assert.equal(problem.path, path.resolve(f[field])); assert.equal(problem.code, code); assert.match(problem.message, wording);
  assert.deepEqual(value.sources.graph.problems, value.sources.repos.problems);
  assert.equal(value.repos.repos.length, 0);
});

test('missing Git explains the prerequisite without exposing subprocess errors', async t => {
  const f = await fixture(t); await f.store.save({ mode: 'live', workspacePaths: [f.root] });
  const value = await createDashboard({ store: f.store, execImpl: async () => { throw Object.assign(new Error('raw-fixture-secret'), { code: 'ENOENT', stderr: 'raw-fixture-secret' }); } }).load();
  const [problem] = value.sources.repos.problems;
  assert.equal(problem.code, 'git-missing'); assert.match(problem.message, /install Git/i); assert.match(problem.message, /restart/i);
  assert.doesNotMatch(JSON.stringify(value), /raw-fixture-secret/);
});

test('unknown Git failures stay bounded and do not become a false not-repository diagnosis', async t => {
  const f = await fixture(t); await f.store.save({ mode: 'live', workspacePaths: [f.root] });
  const value = await createDashboard({ store: f.store, execImpl: async () => { throw Object.assign(new Error('private detail'), { code: 128, stderr: 'private detail' }); } }).load();
  assert.equal(value.sources.repos.problems[0].code, 'git-failed');
  assert.doesNotMatch(JSON.stringify(value), /private detail/);
});

test('valid and partial repositories keep their data; correcting paths clears problems', async t => {
  const f = await fixture(t);
  const partial = await f.load([f.root, f.missing, f.plain]);
  assert.equal(partial.repos.repos.length, 1); assert.ok(partial.graph.nodes.length > 0);
  assert.deepEqual(partial.sources.repos.problems.map(p => p.code), ['path-missing', 'not-repository']);
  assert.deepEqual(partial.sources.repos.problems.map(p => p.path), [f.missing, f.plain]);
  const corrected = await f.load([f.root]);
  assert.equal(corrected.sources.repos.status, 'live'); assert.deepEqual(corrected.sources.repos.problems, []);
  assert.equal(corrected.repos.repos.length, 1); assert.ok(corrected.graph.nodes.length > 0);
});
