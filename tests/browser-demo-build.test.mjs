import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildBrowserDemo, BROWSER_DEMO_FILES } from '../scripts/build-browser-demo.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED = [
  '.nojekyll', 'index.html', 'fixtures.mjs', 'LICENSE',
  'js/app.js', 'js/demo/main.js', 'js/demo/api.js', 'js/demo/settings.js',
  'js/lib/ui.js', 'js/lib/theme.js', 'js/lib/drawer.js', 'js/lib/assistant.js', 'js/lib/local-commands.js',
  ...['graph', 'runtime', 'initiative', 'tasks', 'github', 'news', 'hygiene'].map(name => `js/widgets/${name}.js`),
  ...['tokens', 'fonts', 'app', 'demo', 'connections'].map(name => `css/${name}.css`),
  ...['graph', 'runtime', 'initiative', 'tasks', 'github', 'news', 'hygiene'].map(name => `css/widgets/${name}.css`),
  ...['400', '500', '700'].map(weight => `assets/fonts/jetbrains-mono-${weight}.ttf`),
  ...['400', '700'].map(weight => `assets/fonts/space-mono-${weight}.ttf`),
  'assets/fonts/jetbrains-mono-OFL.txt', 'assets/fonts/space-mono-OFL.txt',
].sort();
async function temporary(run) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'yos-browser-build-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function fileList(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false, `${relative} must not be linked`);
    if (entry.isDirectory()) output.push(...await fileList(directory, relative));
    else { assert.ok(entry.isFile()); output.push(relative); }
  }
  return output.sort();
}
async function snapshot(directory) {
  const source = path.join(directory, 'source');
  for (const file of [...BROWSER_DEMO_FILES, 'index.html', 'scripts/build-browser-demo.mjs']) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await copyFile(path.join(ROOT, file), path.join(source, file));
  }
  const { buildBrowserDemo: build } = await import(pathToFileURL(path.join(source, 'scripts/build-browser-demo.mjs')));
  return { source, build, output: path.join(directory, 'output') };
}
function imports(source) {
  const values = [...source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)].map(match => match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    const reference = match[2];
    if (reference.includes('${')) {
      assert.match(reference, /^\.\/widgets\/\$\{(?:widget\.id|id)\}\.js$/);
      values.push(...['graph', 'runtime', 'initiative', 'tasks', 'github', 'news', 'hygiene'].map(name => reference.replace(/\$\{[^}]+\}/, name)));
    } else values.push(reference);
  }
  return values;
}
function resolveAsset(reference, from, prefix, files) {
  assert.ok(reference.startsWith('./') || reference.startsWith('../'), `${from}: ${reference} must be relative`);
  const base = `https://example.test${prefix}${from}`;
  const url = new URL(reference, base);
  assert.equal(url.origin, 'https://example.test');
  assert.ok(url.pathname.startsWith(prefix), `${reference} escaped the project prefix`);
  const target = decodeURIComponent(url.pathname.slice(prefix.length));
  assert.ok(files.has(target), `${from} refers to missing artifact ${target}`);
  return target;
}

test('browser export has an exact presentation manifest and keeps license notices', async () => {
  await temporary(async directory => {
    const result = await buildBrowserDemo({ outDir: path.join(directory, 'site') });
    assert.deepEqual(result.files, EXPECTED);
    assert.deepEqual(await fileList(result.outDir), EXPECTED);
    for (const file of ['LICENSE', 'assets/fonts/jetbrains-mono-OFL.txt', 'assets/fonts/space-mono-OFL.txt']) {
      assert.deepEqual(await readFile(path.join(result.outDir, file)), await readFile(path.join(ROOT, file)));
    }
    await buildBrowserDemo({ outDir: result.outDir });
    assert.deepEqual(await fileList(result.outDir), EXPECTED);
  });
});

test('every browser module and asset resolves under root and a project subpath', async () => {
  await temporary(async directory => {
    const { outDir } = await buildBrowserDemo({ outDir: path.join(directory, 'site') });
    const files = new Set(await fileList(outDir));
    const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<title>Yunus OS \| Browser demo<\/title>/);
    assert.match(html, /<noscript>/);
    assert.match(html, /Content-Security-Policy[^>]*connect-src 'none'[^>]*form-action 'none'/);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<link'));
    assert.doesNotMatch(html, /src="\.?\/js\/main\.js"/);
    for (const prefix of ['/', '/yunus-os/']) {
      for (const file of files) {
        if (/\.(?:js|mjs)$/.test(file)) {
          const source = await readFile(path.join(outDir, file), 'utf8');
          for (const reference of imports(source)) resolveAsset(reference, file, prefix, files);
        } else if (file.endsWith('.css')) {
          const source = await readFile(path.join(outDir, file), 'utf8');
          for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
            if (!match[1].startsWith('data:')) resolveAsset(match[1], file, prefix, files);
          }
        }
      }
      for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
        if (!match[1].startsWith('data:')) resolveAsset(match[1], 'index.html', prefix, files);
      }
    }
  });
});

test('static artifact contains no live runtime adapters or network and microphone callers', async () => {
  await temporary(async directory => {
    const { outDir } = await buildBrowserDemo({ outDir: path.join(directory, 'site') });
    for (const file of (await fileList(outDir)).filter(file => /\.(?:js|mjs)$/.test(file))) {
      const source = await readFile(path.join(outDir, file), 'utf8');
      assert.doesNotMatch(source, /\bfetch\s*\(|\b(?:WebSocket|EventSource|XMLHttpRequest)\s*\(|\b(?:getUserMedia|sendBeacon|showDirectoryPicker|showOpenFilePicker)\s*\(/, file);
      assert.doesNotMatch(source, /(?:127\.0\.0\.1|localhost|node:child_process|node:fs|\/api\/session|X-Yunus-Token)/, file);
      for (const reference of imports(source)) assert.doesNotMatch(reference, /(?:connections|microphone|pcm-capture)\.js$|(?:^|\/)lib\/api\.js$/, file);
    }
    assert.equal((await fileList(outDir)).some(file => /(?:^|\/)(?:config\.json|tasks\.json|server\.mjs|\.env|runtime|profiles|lib\/config\.mjs)$/.test(file)), false);
  });
});

test('unlisted files, credentials and unlisted symlinks never enter the export', async t => {
  await temporary(async directory => {
    const { source, build, output } = await snapshot(directory);
    for (const file of ['.env', 'config.json', 'tasks.json', 'js/secret.js', 'js/demo/unreviewed.js', 'assets/fonts/private.txt', 'runtime/profile.json']) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), 'BUILD_CANARY_NOT_PUBLIC');
    }
    if (process.platform !== 'win32') await symlink(path.join(source, '.env'), path.join(source, 'js', 'linked-secret.js'));
    else t.diagnostic('Unlisted symlink variant skipped on Windows; unlisted file cases still tested.');
    await build({ outDir: output });
    assert.deepEqual(await fileList(output), EXPECTED);
    for (const file of EXPECTED) assert.equal((await readFile(path.join(output, file))).includes(Buffer.from('BUILD_CANARY_NOT_PUBLIC')), false);
    assert.equal(await readFile(path.join(source, '.env'), 'utf8'), 'BUILD_CANARY_NOT_PUBLIC');
  });
});

test('unknown output files are rejected without deleting or publishing them', async () => {
  await temporary(async directory => {
    const { build, output } = await snapshot(directory);
    await build({ outDir: output });
    const before = await readFile(path.join(output, 'index.html'));
    await writeFile(path.join(output, 'config.json'), 'PRESERVE_THIS_CANARY');
    await assert.rejects(build({ outDir: output }), /unexpected path/);
    assert.equal(await readFile(path.join(output, 'config.json'), 'utf8'), 'PRESERVE_THIS_CANARY');
    assert.deepEqual(await readFile(path.join(output, 'index.html')), before);
  });
});

test('source directories and ancestors cannot be used as output', async () => {
  await temporary(async directory => {
    const { source, build } = await snapshot(directory);
    const before = await readFile(path.join(source, 'index.html'));
    for (const outDir of [source, directory, path.parse(directory).root, path.join(source, 'js'), path.join(source, 'dist', 'another-project')]) {
      await assert.rejects(build({ outDir }), /Output must be/);
    }
    assert.deepEqual(await readFile(path.join(source, 'index.html')), before);
    await build();
    assert.deepEqual(await fileList(path.join(source, 'dist', 'browser-demo')), EXPECTED);
  });
});

test('missing or linked approved sources fail before changing a previous export', async t => {
  if (process.platform === 'win32') return t.skip('Creating symlinks requires extra Windows privileges');
  await temporary(async directory => {
    const { source, build, output } = await snapshot(directory);
    await build({ outDir: output });
    const before = await readFile(path.join(output, 'fixtures.mjs'));
    const input = path.join(source, 'fixtures.mjs');
    await rm(input);
    await assert.rejects(build({ outDir: output }), /ENOENT/);
    const target = path.join(directory, 'private.mjs');
    await writeFile(target, 'SECRET_SYMLINK_CANARY');
    await symlink(target, input);
    await assert.rejects(build({ outDir: output }), /Symlinks/);
    assert.deepEqual(await readFile(path.join(output, 'fixtures.mjs')), before);
    assert.equal(await readFile(target, 'utf8'), 'SECRET_SYMLINK_CANARY');
  });
});

test('output and output-parent symlinks fail without following their targets', async t => {
  if (process.platform === 'win32') return t.skip('Creating symlinks requires extra Windows privileges');
  await temporary(async directory => {
    const { build, output } = await snapshot(directory);
    const target = path.join(directory, 'private'); await mkdir(target);
    await writeFile(path.join(target, 'secret.txt'), 'KEEP');
    await symlink(target, output);
    await assert.rejects(build({ outDir: output }), /Symlinks/);
    await assert.rejects(build({ outDir: path.join(output, 'nested') }), /Symlinks/);
    assert.deepEqual(await readdir(target), ['secret.txt']);
    assert.equal(await readFile(path.join(target, 'secret.txt'), 'utf8'), 'KEEP');
  });
});


test('approved output files cannot redirect writes through symbolic or hard links', async t => {
  await temporary(async directory => {
    const { build, output } = await snapshot(directory);
    await build({ outDir: output });
    const target = path.join(directory, 'outside.js'); await writeFile(target, 'OUTSIDE_FILE_MUST_SURVIVE');
    const existing = path.join(output, 'js', 'app.js'); await rm(existing);
    await link(target, existing);
    await assert.rejects(build({ outDir: output }), /Hard links/);
    assert.equal(await readFile(target, 'utf8'), 'OUTSIDE_FILE_MUST_SURVIVE');
    if (process.platform !== 'win32') {
      await rm(existing); await symlink(target, existing);
      await assert.rejects(build({ outDir: output }), /Symlinks/);
      assert.equal(await readFile(target, 'utf8'), 'OUTSIDE_FILE_MUST_SURVIVE');
    } else t.diagnostic('Symbolic-link variant skipped on Windows; hard-link safety was tested.');
  });
});
