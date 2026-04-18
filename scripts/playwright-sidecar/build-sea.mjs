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
import { existsSync, copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
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
//    `.node` files can't be safely embedded).
//
//    SEA's embedded `require()` only resolves built-in modules. After
//    bundling we patch the generated `require("playwright-core")` call
//    to use `module.createRequire()` rooted at the executable's own
//    directory so it resolves a sibling `node_modules/playwright-core/`.
const bundlePath = resolve(__dirname, 'server.cjs');

// Plan 07-03a: pre-build the picker overlay TS into a single browser-side
// IIFE. Output is a sibling file under picker/overlay/overlay.iife.js — the
// next esbuild step inlines it as a string constant via --loader:.iife.js=text.
// SEA cannot read sibling files at runtime, so the overlay MUST be embedded.
console.log('[playwright-sidecar] Step -1/5: bundle overlay IIFE');
const overlayOut = resolve(__dirname, 'picker', 'overlay', 'overlay.iife.js');
execSync(
  `npx --yes esbuild picker/overlay/index.ts --bundle --format=iife --platform=browser --target=es2022 --outfile=${JSON.stringify(overlayOut)}`,
  { cwd: __dirname, stdio: 'inherit' },
);

console.log('[playwright-sidecar] Step 0/5: esbuild server.mjs → server.cjs');
execSync(
  `npx --yes esbuild server.mjs --bundle --platform=node --format=cjs --external:playwright-core --loader:.iife.js=text --outfile=server.cjs`,
  { cwd: __dirname, stdio: 'inherit' },
);

console.log('[playwright-sidecar] Step 0b/5: patching require("playwright-core") for SEA');
const SEA_REQUIRE_SHIM =
  `const { createRequire: __seaCR } = require("node:module");` +
  `const { dirname: __seaDN, resolve: __seaRV } = require("node:path");` +
  `const { existsSync: __seaEX } = require("node:fs");` +
  `function __seaResolveModules() {` +
  `  const envDir = process.env.STORYCAPTURE_SIDECAR_MODULES;` +
  `  if (envDir && __seaEX(__seaRV(envDir, "playwright-core/package.json"))) return envDir;` +
  `  const exeDir = __seaDN(process.execPath);` +
  `  const candidates = [` +
  `    __seaRV(exeDir, "node_modules"),` +
  `    __seaRV(exeDir, "playwright-sidecar-modules"),` +
  `    __seaRV(exeDir, "../Resources/playwright-sidecar-modules"),` +
  `  ];` +
  `  for (const c of candidates) {` +
  `    if (__seaEX(__seaRV(c, "playwright-core/package.json"))) return c;` +
  `  }` +
  `  throw new Error("playwright-core not found alongside SEA binary; checked: " + candidates.join(", "));` +
  `}` +
  `const __seaModulesDir = __seaResolveModules();` +
  `const __seaRequire = __seaCR(__seaRV(__seaModulesDir, "playwright-core/package.json"));`;
let bundleSrc = readFileSync(bundlePath, 'utf8');
const before = bundleSrc;
bundleSrc = bundleSrc.replace(
  /require\("playwright-core"\)/g,
  '__seaRequire("playwright-core")',
);
if (bundleSrc === before) {
  console.error('[playwright-sidecar] warn: require("playwright-core") not found in bundle — shim not wired');
} else {
  bundleSrc = SEA_REQUIRE_SHIM + '\n' + bundleSrc;
  writeFileSync(bundlePath, bundleSrc);
}

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

// 5. Copy the runtime dependency (playwright-core only — the rest of
//    node_modules is dev-time postject + esbuild). Lives next to the
//    binary so the SEA require shim resolves it.
console.log('[playwright-sidecar] Step 5/6: copying playwright-core next to binary');
const depsDir = resolve(outDir, 'playwright-sidecar-modules');
const srcPw = resolve(__dirname, 'node_modules', 'playwright-core');
const dstPw = resolve(depsDir, 'playwright-core');
if (!existsSync(srcPw)) {
  console.error(`[playwright-sidecar] playwright-core not installed in ${srcPw} — run pnpm install --ignore-workspace`);
  process.exit(1);
}
mkdirSync(depsDir, { recursive: true });
if (existsSync(dstPw)) rmSync(dstPw, { recursive: true, force: true });
// pnpm symlinks playwright-core into its .pnpm store — dereference so the
// copied tree is self-contained and safe to ship in a bundle.
cpSync(srcPw, dstPw, { recursive: true, dereference: true });

// 6. Re-sign after postject injection. macOS kills unsigned Mach-O files
//    modified by postject with SIGKILL before they reach userland. The
//    release pipeline replaces this ad-hoc signature with a real Developer
//    ID signature during notarization.
if (platform() === 'darwin') {
  console.log('[playwright-sidecar] Step 6/6: re-signing (ad-hoc)');
  const signed = spawnSync('codesign', ['--force', '--sign', '-', outPath], {
    stdio: 'inherit',
  });
  if (signed.status !== 0) {
    console.error('[playwright-sidecar] codesign failed');
    process.exit(signed.status || 1);
  }
}

console.log(`[playwright-sidecar] Done: ${outPath}`);
console.log(`[playwright-sidecar] Modules: ${depsDir}`);

function defaultTarget() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin' && a === 'arm64') return 'aarch64-apple-darwin';
  if (p === 'darwin' && a === 'x64') return 'x86_64-apple-darwin';
  if (p === 'win32' && a === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`unsupported host platform: ${p}/${a}`);
}
