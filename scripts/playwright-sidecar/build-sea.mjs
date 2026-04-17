// build-sea.mjs — package server.mjs as a Node 20 SEA (Single Executable
// Application) binary, named `playwright-sidecar-<triple>`, ready to be
// consumed by Tauri's externalBin sidecar mechanism (D-15).
//
// Usage:
//   node build-sea.mjs --target aarch64-apple-darwin
//   node build-sea.mjs --target x86_64-apple-darwin
//   node build-sea.mjs --target x86_64-pc-windows-msvc
//
// Reference: https://nodejs.org/api/single-executable-applications.html
//
// Node SEA has been the recommendation since Node 20 LTS. If SEA proves
// too brittle in this environment (notarization issues with codesign +
// inject), `@yao-pkg/pkg` is the documented fallback — see README.md.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = arg('--target') || defaultTarget();
const isWindows = target.includes('windows');
const ext = isWindows ? '.exe' : '';
const outDir = resolve(__dirname, '..', '..', 'apps', 'desktop', 'src-tauri', 'binaries');
const outName = `playwright-sidecar-${target}${ext}`;
const outPath = resolve(outDir, outName);

console.log(`[playwright-sidecar] Building SEA for target=${target}`);
console.log(`[playwright-sidecar] Output: ${outPath}`);

mkdirSync(outDir, { recursive: true });

// 0. Bundle server.mjs → server.cjs with esbuild. Node SEA doesn't accept
//    ESM entry points, so we pre-bundle into a single CommonJS file while
//    keeping `playwright-core` external (its native chromium launcher +
//    `.node` files can't be safely embedded). The bundled binary resolves
//    playwright-core at runtime from a sibling `node_modules/` directory.
const bundlePath = resolve(__dirname, 'server.cjs');
console.log('[playwright-sidecar] Step 0/4: esbuild server.mjs → server.cjs');
execSync(
  `npx --yes esbuild server.mjs --bundle --platform=node --format=cjs --external:playwright-core --outfile=server.cjs`,
  { cwd: __dirname, stdio: 'inherit' },
);

// 1. Generate the SEA blob.
const blobPath = resolve(__dirname, 'sea-prep.blob');
if (existsSync(blobPath)) rmSync(blobPath);
console.log('[playwright-sidecar] Step 1/4: generating SEA blob');
execSync('node --experimental-sea-config sea-config.json', {
  cwd: __dirname,
  stdio: 'inherit',
});

// 2. Copy the host node binary into the output path.
console.log('[playwright-sidecar] Step 2/4: copying node binary');
copyFileSync(process.execPath, outPath);

// 3. On macOS, strip the existing signature so postject can inject; the
//    Tauri build pipeline (Plan 02 / Plan 10) re-signs each sidecar
//    binary as part of the notarization walk.
if (platform() === 'darwin') {
  console.log('[playwright-sidecar] Step 3/4: stripping macOS signature');
  spawnSync('codesign', ['--remove-signature', outPath], { stdio: 'inherit' });
}

// 4. Inject the blob into the binary copy via postject.
console.log('[playwright-sidecar] Step 4/4: postject inject');
const postjectArgs = [
  'postject',
  outPath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (platform() === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
const r = spawnSync('npx', postjectArgs, { stdio: 'inherit', cwd: __dirname });
if (r.status !== 0) {
  console.error('[playwright-sidecar] postject failed');
  process.exit(r.status || 1);
}

console.log(`[playwright-sidecar] Done: ${outPath}`);

function defaultTarget() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return 'aarch64-apple-darwin';
  if (p === 'darwin' && a === 'x64') return 'x86_64-apple-darwin';
  if (p === 'win32' && a === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`unsupported host platform: ${p}/${a}`);
}
