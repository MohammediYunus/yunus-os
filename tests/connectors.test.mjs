import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaults } from '../lib/config.mjs';
import { collectGitHub, createDashboard } from '../lib/connectors.mjs';
const exec = promisify(execFile);
const fixtureEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (root, ...args) => exec('git', ['-c', 'core.hooksPath=/nonexistent-yunus-test-hooks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env: fixtureEnvironment });
const storeFor = (config, tasks = []) => ({ get: () => structuredClone(config), tasks: () => structuredClone(tasks) });

async function fixture(run) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yos-repo-test-'));
  const root = path.join(base, 'project with spaces'); await mkdir(root);
  try {
    await git(root, 'init', '-b', 'main');
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
    await writeFile(path.join(root, 'a.ts'), "import { value } from './b';\nconsole.log(value);\n");
    await writeFile(path.join(root, 'b.ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, 'notes.md'), 'Original note\n');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Initial fixture');
    await run(root, base);
  } finally { await rm(base, { recursive: true, force: true }); }
}

test('demo performs no network or Git subprocess even when credentials and folders are configured', async () => {
  const config = defaults(); config.workspacePaths = ['/must/not/read']; config.github = { username: 'alice', repositories: ['alice/orbit'], token: 'fixture-secret' };
  const board = createDashboard({ store: storeFor(config), fetchImpl: () => { throw new Error('demo must not fetch'); }, execImpl: () => { throw new Error('demo must not execute'); } });
  const value = await board.load();
  assert.equal(value.demo, true); assert.equal(value.sources.graph.status, 'demo');
  assert.doesNotMatch(JSON.stringify(value), /fixture-secret|must\/not\/read/);
  assert.equal(value.runtime.voiceReady, false);
});

test('live disconnected mode has honest empty sources and actual voice dependency readiness', async () => {
  const config = defaults(); config.mode = 'live'; config.voice.enabled = true; config.voice.whisperExecutable = '/not-a-real-whisper';
  const value = await createDashboard({ store: storeFor(config), fetchImpl: () => { throw new Error('not configured'); }, execImpl: () => { throw new Error('not configured'); } }).load();
  assert.equal(value.demo, false); assert.equal(value.graph, null); assert.equal(value.github, null);
  assert.equal(value.sources.news.status, 'disabled'); assert.deepEqual(value.news.items, []);
  assert.equal(value.runtime.voiceEnabled, true); assert.equal(value.runtime.voiceReady, false); assert.match(value.runtime.voiceReason, /whisper-cli/);
  assert.equal(value.runtime.connectedSources, Object.values(value.sources).filter(source => source.status === 'live').length);
});

test('real selected repo counts staged, unstaged, deleted and each untracked file; graph resolves relative imports', async () => {
  await fixture(async (root, base) => {
    await writeFile(path.join(root, 'a.ts'), "import { value } from './b';\nconsole.log(value + 1);\n");
    await writeFile(path.join(root, 'b.ts'), 'export const value = 2;\n'); await git(root, 'add', 'b.ts');
    await rm(path.join(root, 'notes.md')); await mkdir(path.join(root, 'new-folder'));
    await writeFile(path.join(root, 'new-folder', 'one.ts'), 'export const one = 1;');
    await writeFile(path.join(root, 'new-folder', 'two.ts'), 'export const two = 2;');
    await mkdir(path.join(root, 'node_modules')); await writeFile(path.join(root, 'node_modules', 'ignored.js'), 'IGNORE');
    await writeFile(path.join(root, '.env'), 'IGNORE');
    const monitor = path.join(base, 'fsmonitor');
    if (process.platform !== 'win32') {
      await writeFile(monitor, '#!/bin/sh\nprintf called > "$0.called"\n'); await chmod(monitor, 0o700);
      await git(root, 'config', 'core.fsmonitor', monitor);
    }
    const config = defaults(); config.mode = 'live'; config.workspacePaths = [root];
    const value = await createDashboard({ store: storeFor(config), fetchImpl: () => { throw new Error('no network'); } }).load();
    const repo = value.repos.repos[0];
    assert.equal(repo.branch, 'main'); assert.equal(repo.dirtyFiles, 5); assert.equal(repo.staged, 1);
    assert.equal(repo.unstaged, 2); assert.equal(repo.untracked, 2); assert.equal(repo.deleted, 1); assert.equal(repo.worktree, false);
    assert.equal(value.sources.graph.status, 'live');
    assert.ok(value.graph.links.some(link => link.source === 'repo0:a.ts' && link.target === 'repo0:b.ts' && link.kind === 'import'));
    assert.ok(!value.graph.nodes.some(node => /node_modules|\.env|notes\.md/.test(node.label)));
    assert.ok(value.news.items.some(item => item.source === 'git' && item.title.includes('Initial fixture')));
    await assert.rejects(access(monitor + '.called'));
  });
});

test('only selected worktree is inspected and outside symlink source is excluded', async t => {
  await fixture(async (root, base) => {
    const linked = path.join(base, 'linked'); await git(root, 'worktree', 'add', '-b', 'feature', linked);
    if (process.platform !== 'win32') {
      const outside = path.join(base, 'outside.ts'); await writeFile(outside, 'PRIVATE OUTSIDE FIXTURE');
      await symlink(outside, path.join(linked, 'linked-source.ts'));
    }
    const config = defaults(); config.mode = 'live'; config.workspacePaths = [linked];
    const value = await createDashboard({ store: storeFor(config) }).load();
    assert.equal(value.repos.repos.length, 1); assert.equal(value.repos.repos[0].worktree, true); assert.equal(value.repos.repos[0].branch, 'feature');
    assert.ok(!value.graph.nodes.some(node => node.label === 'linked-source.ts'));
  });
});

test('one unavailable selected repo does not erase valid repo data or fabricate a graph', async () => {
  await fixture(async root => {
    const config = defaults(); config.mode = 'live'; config.workspacePaths = [root, path.join(root, 'missing')];
    const value = await createDashboard({ store: storeFor(config) }).load();
    assert.equal(value.sources.repos.status, 'error'); assert.equal(value.repos.repos.length, 1); assert.ok(value.graph.nodes.length > 0);
    assert.match(value.sources.repos.message, /1 connected, 1 unavailable/);
  });
});

test('mocked GitHub normalizes API records, denies redirects and sends token only as an auth header', async () => {
  const config = defaults(); config.github = { username: 'alice', repositories: ['alice/orbit'], token: 'fixture-secret' };
  const calls = [], timestamp = '2026-01-01T10:00:00Z';
  const issue = { repository_url: 'https://api.github.com/repos/alice/orbit', number: 3, title: 'Fix orbit', user: { login: 'alice' }, created_at: timestamp, updated_at: timestamp, html_url: 'https://github.com/alice/orbit/pull/3', draft: true, labels: [{ name: 'bug' }, 'help wanted'] };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('/actions/runs') ? { workflow_runs: [{ name: 'CI', head_branch: 'main', conclusion: 'success', status: 'completed', updated_at: timestamp, html_url: 'https://github.com/alice/orbit/actions/runs/5' }] } : { items: [issue] } };
  };
  const result = await collectGitHub(config, fetchImpl);
  assert.equal(calls.length, 4); assert.equal(result.myOpenPRs[0].repo, 'alice/orbit'); assert.equal(result.myOpenPRs[0].isDraft, true);
  assert.deepEqual(result.openIssues[0].labels, ['bug', 'help wanted']); assert.equal(result.recentRuns[0].conclusion, 'success');
  for (const call of calls) { assert.equal(call.options.redirect, 'error'); assert.equal(call.options.headers.Authorization, 'Bearer fixture-secret'); assert.ok(!call.url.includes('fixture-secret')); }
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
});

test('GitHub failure is visible without leaking response body, credentials or old synthetic data', async () => {
  const config = defaults(); config.mode = 'live'; config.github.username = 'alice'; config.github.token = 'fixture-secret';
  const value = await createDashboard({ store: storeFor(config), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'private response body' }) }) }).load();
  assert.equal(value.github, null); assert.equal(value.sources.github.status, 'error'); assert.match(value.sources.github.message, /rejected the token/);
  assert.doesNotMatch(JSON.stringify(value), /fixture-secret|private response body/);
});

test('live Activity uses existing GitHub and local task events with no additional API call, updates after cache', async () => {
  const config = defaults(); config.mode = 'live'; config.github.username = 'alice';
  const tasks = [{ id: 'task1', title: 'Review the release', done: false, createdAt: '2026-01-02T12:00:00Z' }];
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, json: async () => ({ items: [{ repository_url: 'https://api.github.com/repos/alice/orbit', number: 3, title: 'Fix orbit', created_at: '2026-01-01T10:00:00Z', updated_at: '2026-01-02T10:00:00Z', html_url: 'https://github.com/alice/orbit/pull/3' }] }) }; };
  const board = createDashboard({ store: { get: () => config, tasks: () => structuredClone(tasks) }, fetchImpl });
  const first = await board.load(); assert.equal(fetches, 3); assert.equal(first.sources.news.status, 'live');
  assert.equal(first.news.items[0].source, 'local'); assert.equal(first.news.items.filter(item => item.tag === 'PR').length, 1);
  tasks.push({ id: 'task2', title: 'New task', done: false, createdAt: '2026-01-03T12:00:00Z' });
  const second = await board.load(); assert.equal(fetches, 3); assert.equal(second.news.items[0].title, 'Task added: New task');
});
