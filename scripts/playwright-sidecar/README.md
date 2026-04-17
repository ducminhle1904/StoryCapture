# Playwright Sidecar

The StoryCapture **Playwright sidecar** wraps `playwright-core`'s Chromium
driver behind a JSON-RPC 2.0 server reading from stdin and writing to
stdout. The Rust `crates/automation::PlaywrightSidecarDriver` speaks the
protocol; the Tauri host launches the binary as a `tauri-plugin-shell`
sidecar.

This sidecar is the **fallback driver** for verbs that chromiumoxide
handles weakly (PITFALLS #3): file upload, wait-for-download, shadow-DOM
piercing, OAuth popups (D-14, D-15, AUTO-06).

## Local development

```bash
cd scripts/playwright-sidecar
pnpm install
node server.mjs
```

Send a request on stdin:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"capabilities"}' | node server.mjs
```

Expected response (one line):

```json
{"jsonrpc":"2.0","id":1,"result":{"file_upload":true,"wait_for_download":true,"shadow_dom_click":true,"oauth_popup":true,"network_idle":true,"iframes":true}}
```

## SEA build

> **Node 20 LTS required.** Node 24's SEA injector silently fails to boot
> the embedded script in our testing; the CI workflow pins `node-version:
> '20'` for the same reason. If you're on Node 24 via nvm, switch to a
> Node 20 shell before running `build-sea.mjs`:
>
> ```bash
> nvm install 20 && nvm use 20
> ```

```bash
node build-sea.mjs --target aarch64-apple-darwin
node build-sea.mjs --target x86_64-apple-darwin
node build-sea.mjs --target x86_64-pc-windows-msvc
```

Output lands in `apps/desktop/src-tauri/binaries/playwright-sidecar-<triple>`
where Tauri's `externalBin` mechanism picks it up (the binary name is
required by Tauri to end with the target triple).

The build pipeline:

1. **esbuild** bundles `server.mjs` → `server.cjs` as a single CommonJS
   file, keeping `playwright-core` marked `external` so its native
   chromium launcher isn't embedded (the SEA binary would crash on the
   `.node` loader).
2. `node --experimental-sea-config sea-config.json` → produces
   `sea-prep.blob` from `server.cjs`.
3. Copy the host `node` binary to the output path.
4. On macOS: `codesign --remove-signature` so postject can inject; the
   Tauri build pipeline (Plan 02 / Plan 10) re-signs every sidecar binary
   as part of notarization.
5. `npx postject` injects the blob into the binary using the SEA fuse
   sentinel `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`.

### Runtime shape (TODO for production bundling)

Because `playwright-core` is external, the SEA binary at runtime expects
its `node_modules/playwright-core/` directory to live at a resolvable
path. The Tauri bundler currently only copies the single binary into
`StoryCapture.app/Contents/MacOS/`. The release pipeline needs an
additional step to ship `node_modules/playwright-core/` alongside
(likely via `bundle.resources` pointing at a pre-packed module tree, and
a wrapper that sets `NODE_PATH` before `exec`ing the SEA binary).

Until that ships, local dev uses the shell wrapper at
`apps/desktop/src-tauri/binaries/playwright-sidecar-<triple>` which
execs `node server.mjs` against the repo checkout. See that file.

If Node SEA proves too brittle, `@yao-pkg/pkg` is the documented
fallback — see RESEARCH.md §Standard Stack.

## Chromium browser binary (RESEARCH Q2 — first-run download)

The Chromium binary is **NOT bundled** in the StoryCapture installer.
Bundling Playwright's Chromium would add ~150 MB and blow the <50 MB
installer budget (DIST-04). Instead:

- On first launch, the sidecar checks `process.env.PLAYWRIGHT_BROWSERS_PATH`
  (default `~/Library/Caches/ms-playwright` on macOS,
  `%LOCALAPPDATA%\ms-playwright` on Windows) for the playwright-core
  managed Chromium.
- If absent, the host UI surfaces a one-time download prompt and runs
  `npx playwright install chromium` (or the equivalent
  `playwright-core` install API).
- Subsequent launches reuse the cached browser.

This keeps the installer small and avoids re-shipping Chromium with every
StoryCapture update.

## Licensing

- `playwright-core` — Apache 2.0
- Chromium — BSD-style + LGPL components
- Node — MIT

All compatible with direct distribution + notarization (DIST-01..02).

## CI

`.github/workflows/playwright-sidecar-build.yml` builds all three triples
on every PR that touches `scripts/playwright-sidecar/**`. Artifacts are
uploaded for download. The release pipeline (Plan 10) signs and notarizes
the per-triple binaries before bundling them with the desktop app.
