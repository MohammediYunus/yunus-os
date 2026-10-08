#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUTPUT = path.join(ROOT, 'dist', 'browser-demo');

// Only these reviewed presentation sources can enter the public artifact.
export const BROWSER_DEMO_FILES = Object.freeze([
  'fixtures.mjs', 'LICENSE',
  'js/app.js', 'js/demo/main.js', 'js/demo/api.js', 'js/demo/settings.js',
  'js/lib/ui.js', 'js/lib/theme.js', 'js/lib/drawer.js',
  'js/lib/assistant.js', 'js/lib/local-commands.js',
  'js/widgets/graph.js', 'js/widgets/runtime.js', 'js/widgets/initiative.js',
  'js/widgets/tasks.js', 'js/widgets/github.js', 'js/widgets/news.js', 'js/widgets/hygiene.js',
  'css/tokens.css', 'css/fonts.css', 'css/app.css', 'css/demo.css', 'css/connections.css',
  'css/widgets/graph.css', 'css/widgets/runtime.css', 'css/widgets/initiative.css',
  'css/widgets/tasks.css', 'css/widgets/github.css', 'css/widgets/news.css', 'css/widgets/hygiene.css',
  'assets/fonts/jetbrains-mono-400.ttf', 'assets/fonts/jetbrains-mono-500.ttf',
  'assets/fonts/jetbrains-mono-700.ttf', 'assets/fonts/space-mono-400.ttf',
  'assets/fonts/space-mono-700.ttf', 'assets/fonts/jetbrains-mono-OFL.txt',
  'assets/fonts/space-mono-OFL.txt',
]);
export const BROWSER_DEMO_OUTPUT_FILES = Object.freeze(['index.html', '.nojekyll', ...BROWSER_DEMO_FILES].sort());
const OUTPUT_DIRECTORIES = new Set(BROWSER_DEMO_FILES.flatMap(file => {
  const parts = file.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

async function noSymlinkAncestors(target) {
  const parsed = path.parse(target); let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlinks are not allowed in build paths: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function sourceFile(relative) {
  const filename = path.join(ROOT, relative);
  await noSymlinkAncestors(filename);
  if (!(await lstat(filename)).isFile()) throw new Error(`Build input must be a regular file: ${relative}`);
  return readFile(filename);
}
function demoHTML(source) {
  const entry = /<script\s+type="module"\s+src="\.?\/js\/main\.js"><\/script>/g;
  if ([...source.matchAll(entry)].length !== 1) throw new Error('Expected exactly one local app entry in index.html');
  return source.replace(entry, '<script type="module" src="./js/demo/main.js"></script>')
    .replace('<title>Yunus OS</title>', '<title>Yunus OS | Browser demo</title>')
    .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Explore Yunus OS with a synthetic workspace. Browser tasks stay on this device; no accounts or setup required.">')
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`)
    .replace('<body>', '<body>\n  <noscript><style>#boot, #app { display: none; }</style><p>This interactive demo needs JavaScript. <a href="https://github.com/MohammediYunus/yunus-os">Read about Yunus OS on GitHub</a>.</p></noscript>');
}
async function checkOutput(directory, relative = '') {
  let entries;
  try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in output: ${name}`);
    if (entry.isDirectory() && OUTPUT_DIRECTORIES.has(name)) await checkOutput(directory, name);
    else if (!entry.isFile() || !BROWSER_DEMO_OUTPUT_FILES.includes(name)) {
      throw new Error(`Output contains an unexpected path; choose an empty directory: ${name}`);
    } else if ((await lstat(path.join(directory, name))).nlink > 1) {
      throw new Error(`Hard links are not allowed in output: ${name}`);
    }
  }
}
export async function buildBrowserDemo({ outDir = DEFAULT_OUTPUT } = {}) {
  if (typeof outDir !== 'string' || !outDir.trim()) throw new Error('Output directory must be a nonempty path');
  const output = path.resolve(outDir), source = path.resolve(ROOT);
  const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  if (contains(output, source) || (contains(source, output) && output !== DEFAULT_OUTPUT)) {
    throw new Error('Output must be dist/browser-demo or a separate directory outside the source');
  }
  await noSymlinkAncestors(output);
  await checkOutput(output);
  // Read and validate every source before touching an existing artifact.
  const files = await Promise.all(BROWSER_DEMO_FILES.map(async file => [file, await sourceFile(file)]));
  files.push(['index.html', demoHTML((await sourceFile('index.html')).toString('utf8'))], ['.nojekyll', '']);
  await mkdir(output, { recursive: true });
  for (const [file, contents] of files) {
    const destination = path.join(output, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return { outDir: output, files: [...BROWSER_DEMO_OUTPUT_FILES] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/build-browser-demo.mjs'); process.exitCode = 1;
  } else {
    try { const result = await buildBrowserDemo(); console.log(`Built ${result.files.length} browser-demo files in ${result.outDir}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
