import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssistant, findExecutable, runTextProcess } from '../lib/assistant.mjs';
import { voiceCapabilities } from '../lib/voice.mjs';

async function withPath(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yos tools '));
  const previous = process.env.PATH;
  process.env.PATH = root;
  try { await fn(root); }
  finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('executable discovery accepts explicit native paths and rejects missing files and directories', async () => {
  assert.equal(await findExecutable(process.execPath), process.execPath);
  assert.equal(await findExecutable(''), null);
  await withPath(async root => {
    assert.equal(await findExecutable('missing-provider'), null);
    await mkdir(path.join(root, 'directory.exe'));
    assert.equal(await findExecutable(path.join(root, 'directory.exe')), null);
  });
});

test('relative PATH entries resolve to absolute executable paths', async () => {
  await withPath(async root => {
    const filename = process.platform === 'win32' ? 'provider.exe' : 'provider';
    const executable = path.join(root, filename);
    await writeFile(executable, 'fixture', { mode: 0o755 });
    process.env.PATH = path.relative(process.cwd(), root);
    assert.equal(await findExecutable(filename), executable);
  });
});

test('POSIX discovery preserves exact names and requires executable permission', { skip: process.platform === 'win32' }, async () => {
  await withPath(async root => {
    const executable = path.join(root, 'provider');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
    assert.equal(await findExecutable('provider'), null);
    await chmod(executable, 0o700);
    assert.equal(await findExecutable('provider'), executable);
    await writeFile(path.join(root, 'other.exe'), 'fixture', { mode: 0o700 });
    assert.equal(await findExecutable('other'), null);
  });
});

test('Windows default providers find native executables and launch with literal arguments from another cwd', { skip: process.platform !== 'win32' }, async () => {
  await withPath(async root => {
    const claude = path.join(root, 'claude.exe');
    const whisper = path.join(root, 'whisper-cli.exe');
    await copyFile(process.execPath, claude);
    await copyFile(process.execPath, whisper);
    await writeFile(path.join(root, 'claude'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'claude.cmd'), '@exit /b 1\n');
    assert.equal(await findExecutable('claude'), claude);
    assert.equal(await findExecutable('whisper-cli'), whisper);
    const assistant = createAssistant({ getConfig: () => ({ assistant: { provider: 'claude' } }), getDashboard: () => ({}) });
    assert.equal((await assistant.capabilities()).available, true);
    const model = path.join(root, 'model.bin');
    await writeFile(model, 'synthetic model fixture');
    assert.equal((await voiceCapabilities({ enabled: true, whisperModelPath: model })).available, true);
    const cwd = path.join(root, 'working directory');
    await mkdir(cwd);
    const literal = 'hello & echo unexpected | %PATH% $(not-a-command)';
    assert.equal(await runTextProcess(await findExecutable('claude'), ['-e', 'process.stdout.write(process.argv[1])', literal], { cwd }), literal);
  });
});

test('Windows discovery supports explicit native suffixes and both relative path separators', { skip: process.platform !== 'win32' }, async () => {
  await withPath(async root => {
    const executable = path.join(root, 'custom.EXE');
    await writeFile(executable, 'native file fixture');
    assert.equal(await findExecutable(executable), executable);
    const relative = path.relative(process.cwd(), executable);
    assert.equal(await findExecutable(relative), executable);
    assert.equal(await findExecutable(relative.replaceAll('\\', '/')), executable);
  });
});

test('Windows discovery preserves PATH directory precedence and accepts native COM files', { skip: process.platform !== 'win32' }, async () => {
  await withPath(async root => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await mkdir(first); await mkdir(second);
    const executable = path.join(first, 'provider.COM');
    await writeFile(executable, 'native file fixture');
    await writeFile(path.join(second, 'provider.exe'), 'native file fixture');
    process.env.PATH = [first, second].join(path.delimiter);
    assert.equal((await findExecutable('provider')).toLowerCase(), executable.toLowerCase());
    assert.equal(await findExecutable(executable), executable);
  });
});

test('Windows discovery does not report shell or interpreter wrappers as ready', { skip: process.platform !== 'win32' }, async () => {
  await withPath(async root => {
    for (const suffix of ['', '.cmd', '.bat', '.ps1', '.js']) {
      const file = path.join(root, `provider${suffix}`);
      await writeFile(file, 'script fixture');
      assert.equal(await findExecutable(file), null);
    }
    assert.equal(await findExecutable('provider'), null);
  });
});
