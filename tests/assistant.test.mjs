import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistant, runTextProcess, workspaceSummary } from '../lib/assistant.mjs';

const dashboard = { demo: false, tasks: { items: [{ title: 'Review release notes', done: false }, { title: 'Already finished', done: true }] }, repos: { repos: [{ name: 'orbit', path: '/private/unrelated', branch: 'main', dirtyFiles: 3 }] }, github: { myOpenPRs: [{ title: 'Fix focus handling', ci: 'failing' }], reviewRequested: [] }, sources: { github: { status: 'error' } } };

test('local assistant uses real passed dashboard and distinguishes demo without invoking providers', async () => {
  let fetches = 0;
  const assistant = createAssistant({ getConfig: () => ({ assistant: { provider: 'local' } }), getDashboard: () => dashboard, fetchImpl: () => { fetches++; throw new Error('must not fetch'); } });
  const result = await assistant.ask('What are my tasks?');
  assert.equal(result.provider, 'local');
  assert.match(result.text, /Review release notes/);
  assert.doesNotMatch(result.text, /Already finished/);
  assert.equal(fetches, 0);
  assert.match(workspaceSummary({ ...dashboard, demo: true }), /fictional data/);
  assert.doesNotMatch(workspaceSummary(dashboard), /private\/unrelated/);
  assert.match(workspaceSummary(dashboard), /Unavailable sources: github/);
});

test('actions are narrowly proposed and never executed', async () => {
  const assistant = createAssistant({ getConfig: () => ({}), getDashboard: () => dashboard });
  assert.deepEqual((await assistant.ask('open Calculator')).actions, [{ type: 'open_app', app: 'Calculator' }]);
  assert.equal((await assistant.ask('open Terminal')).actions, undefined);
  assert.equal((await assistant.ask('open https://user:password@example.com')).actions, undefined);
  assert.deepEqual((await assistant.ask('open https://example.com')).actions, [{ type: 'open_url', url: 'https://example.com/' }]);
});

test('Ollama makes one explicit local request, with redirects denied and no inherited config secrets', async () => {
  let request;
  const assistant = createAssistant({ getConfig: () => ({ github: { token: 'NEVER_INCLUDE_ME' }, assistant: { provider: 'ollama', model: 'local-model', endpoint: 'http://127.0.0.1:11434' } }), getDashboard: () => dashboard, fetchImpl: async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ response: 'One task needs review.' }) }; } });
  assert.equal((await assistant.ask('What needs attention?')).text, 'One task needs review.');
  assert.equal(request.url.href, 'http://127.0.0.1:11434/api/generate');
  assert.equal(request.init.redirect, 'error');
  assert.doesNotMatch(request.init.body, /NEVER_INCLUDE_ME/);
  assert.match(request.init.body, /Review release notes/);
});

test('Ollama rejects remote endpoints and missing models before network access', async () => {
  let calls = 0;
  const config = { assistant: { provider: 'ollama', endpoint: 'https://example.com', model: 'a' } };
  const assistant = createAssistant({ getConfig: () => config, getDashboard: () => dashboard, fetchImpl: () => { calls++; } });
  await assert.rejects(assistant.ask('hello'), /loopback/);
  config.assistant.endpoint = 'http://127.0.0.1:11434'; config.assistant.model = '';
  await assert.rejects(assistant.ask('hello'), /Choose an installed/);
  assert.equal(calls, 0);
});

test('Claude invocation has no tools or persistence and uses a disposable working directory', async () => {
  let captured;
  const assistant = createAssistant({ getConfig: () => ({ assistant: { provider: 'claude', executable: process.execPath } }), getDashboard: () => dashboard, processRunner: async (binary, args, options) => { captured = { binary, args, options }; await access(options.cwd); return 'Review the failing check first.'; } });
  assert.equal((await assistant.ask('What next?')).provider, 'claude');
  for (const flag of ['--restricted', '--no-session-persistence', '--strict-mcp-config', '--no-chrome']) assert.ok(captured.args.includes(flag));
  assert.equal(captured.args[captured.args.indexOf('--tools') + 1], '');
  assert.equal(captured.args[captured.args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.ok(!captured.args.includes('--dangerously-skip-permissions'));
  await assert.rejects(access(captured.options.cwd));
});

test('cancel aborts in-flight provider fetch and does not affect future local requests', async () => {
  const config = { assistant: { provider: 'ollama', model: 'a' } };
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const assistant = createAssistant({ getConfig: () => config, getDashboard: () => dashboard, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); started(); }) });
  const pending = assistant.ask('summary');
  await ready; assistant.cancel();
  await assert.rejects(pending, { name: 'AbortError' });
  config.assistant.provider = 'local';
  assert.equal((await assistant.ask('tasks')).provider, 'local');
});

test('real subprocess arguments are literal and stderr is not exposed', async () => {
  const text = await runTextProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);', '$(touch forbidden); literal']);
  assert.equal(text, '$(touch forbidden); literal');
  await assert.rejects(runTextProcess(process.execPath, ['-e', 'process.stderr.write("private-token");process.exit(1)']), error => !error.message.includes('private-token'));
});

test('real cancellation kills an owned process that ignores SIGTERM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yos-cancel-test-'));
  const ready = path.join(root, 'ready');
  const script = path.join(root, 'worker.mjs');
  await writeFile(script, `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = runTextProcess(process.execPath, [script, ready], { signal: controller.signal, timeoutMs: 5000 });
  try {
    for (let i = 0; i < 100; i++) { try { await access(ready); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    await access(ready);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});
