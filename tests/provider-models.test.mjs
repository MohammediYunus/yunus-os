import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore, defaults, validateConfig } from '../lib/config.mjs';
import { createAssistant } from '../lib/assistant.mjs';

async function profile(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yos-models-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('provider-only switches keep Ollama requests and Claude arguments independent', async () => {
  await profile(async directory => {
    const store = await createConfigStore(directory), calls = [], requests = [];
    const assistant = createAssistant({ getConfig: store.get, getDashboard: () => ({}),
      processRunner: async (_binary, args) => { calls.push(args); return 'Fixture reply'; },
      fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ response: 'Fixture reply' }) }; },
    });
    await store.save({ assistant: { provider: 'ollama', model: 'qwen3:8b', executable: process.execPath } });
    await store.save({ assistant: { provider: 'claude' } });
    assert.equal(calls.length + requests.length, 0, 'Saving does not invoke providers');
    await assistant.ask('summary');
    assert.ok(!calls.at(-1).includes('--model'), 'Ollama model must not override Claude');
    await store.save({ assistant: { claudeModel: 'my-claude-model' } });
    for (const provider of ['ollama', 'local', 'claude', 'ollama', 'claude']) {
      await store.save({ assistant: { provider } });
      await assistant.ask('summary');
    }
    assert.deepEqual(requests.map(request => request.model), ['qwen3:8b', 'qwen3:8b']);
    assert.deepEqual(calls.slice(1).map(args => args[args.indexOf('--model') + 1]), ['my-claude-model', 'my-claude-model']);
  });
});

test('model-only updates, explicit clears and provider-only switches survive restart', async () => {
  await profile(async directory => {
    let store = await createConfigStore(directory);
    await store.save({ assistant: { model: 'local-model', claudeModel: 'custom-claude', provider: 'claude' } });
    await store.save({ assistant: { model: 'changed-local' } });
    assert.equal(store.get().assistant.claudeModel, 'custom-claude');
    await store.save({ assistant: { claudeModel: '' } });
    store = await createConfigStore(directory);
    assert.equal(store.get().assistant.model, 'changed-local');
    assert.equal(store.get().assistant.claudeModel, '');
    await store.save({ displayName: 'Renamed workspace', assistant: { provider: 'ollama' } });
    assert.equal(store.get().assistant.model, 'changed-local');
    await store.save({ assistant: { claudeModel: 'restored-claude', model: '' } });
    store = await createConfigStore(directory);
    assert.equal(store.get().assistant.model, '');
    assert.equal(store.get().assistant.claudeModel, 'restored-claude');
  });
});

for (const [provider, model, expectedOllama, expectedClaude] of [
  ['ollama', 'qwen3:8b', 'qwen3:8b', ''],
  ['local', 'unclassified-model', 'unclassified-model', ''],
  ['claude', 'custom/provider-model', '', 'custom/provider-model'],
  ['claude', 'qwen3:8b', '', 'qwen3:8b'],
  ['claude', '', '', ''],
]) test(`legacy ${provider} profile migrates ${model || 'empty model'} without guessing model names`, async () => {
  await profile(async directory => {
    const legacy = defaults(); delete legacy.assistant.claudeModel;
    Object.assign(legacy.assistant, { provider, model });
    await writeFile(path.join(directory, 'config.json'), JSON.stringify(legacy));
    const store = await createConfigStore(directory);
    assert.equal(store.get().assistant.model, expectedOllama);
    assert.equal(store.get().assistant.claudeModel, expectedClaude);
    await store.save({ assistant: { provider: 'claude' } });
    const reopened = await createConfigStore(directory);
    assert.equal(reopened.get().assistant.model, expectedOllama);
    assert.equal(reopened.get().assistant.claudeModel, expectedClaude);
    const saved = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
    assert.equal(saved.assistant.claudeModel, expectedClaude);
  });
});

test('explicit canonical Claude selection takes precedence over legacy migration, including empty', async () => {
  await profile(async directory => {
    for (const claudeModel of ['', 'explicit-claude']) {
      const config = defaults();
      Object.assign(config.assistant, { provider: 'claude', model: 'saved-ollama', claudeModel });
      await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
      const store = await createConfigStore(directory);
      assert.equal(store.get().assistant.model, 'saved-ollama');
      assert.equal(store.get().assistant.claudeModel, claudeModel);
    }
  });
});

test('both model fields reject invalid values without replacing persisted choices', async () => {
  await profile(async directory => {
    const store = await createConfigStore(directory);
    await store.save({ assistant: { model: 'local', claudeModel: 'claude' } });
    for (const field of ['model', 'claudeModel']) {
      for (const value of [null, [], {}, 'bad\nmodel', 'x'.repeat(1001)]) {
        await assert.rejects(store.save({ assistant: { [field]: value } }), /Invalid/);
        assert.equal(store.get().assistant.model, 'local');
        assert.equal(store.get().assistant.claudeModel, 'claude');
      }
    }
    assert.equal(validateConfig({ assistant: { claudeModel: '  custom alias  ' } }).assistant.claudeModel, 'custom alias');
  });
});
