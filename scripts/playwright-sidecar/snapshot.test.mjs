// captureSnapshot JSON-RPC verb integration test.
//
// Spawns the real Node sidecar, loads a local fixture via file:// URL, and
// asserts the returned DOM hash + screenshot payload. Uses the same
// spawn/call harness pattern as server.test.mjs so the two suites share
// CI cost (one Chromium download).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, 'server.mjs');
const FIXTURE_URL = pathToFileURL(
  resolve(__dirname, 'tests/fixtures/snapshot.html'),
).toString();

function spawnSidecar() {
  const child = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id } = msg;
    if (id === undefined || id === null) return;
    const w = pending.get(id);
    if (w) {
      pending.delete(id);
      w(msg);
    }
  });
  child.stderr.on('data', () => {});
  return {
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`timeout waiting for ${method}`));
        }, 60_000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) rej(msg);
          else res(msg);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        );
      });
    },
    async dispose() {
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
    },
  };
}

describe('captureSnapshot RPC', () => {
  let sidecar;
  beforeEach(() => {
    sidecar = spawnSidecar();
  });
  afterEach(async () => {
    await sidecar.dispose();
  });

  it('rejects missing/empty url', async () => {
    // The sidecar JSON-RPC dispatcher wraps caught exceptions with
    // code: -32000 and the original message verbatim.
    await expect(sidecar.call('captureSnapshot', {})).rejects.toMatchObject({
      error: expect.objectContaining({
        code: -32000,
        message: expect.stringContaining('url must be a non-empty string'),
      }),
    });
  });

  it('rejects unsupported URL schemes (chrome://)', async () => {
    await expect(
      sidecar.call('captureSnapshot', { url: 'chrome://settings' }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ code: -32000 }),
    });
  });

  it(
    'returns domHash + innerHTML + screenshotBase64 for a local fixture',
    async () => {
      const resp = await sidecar.call('captureSnapshot', {
        url: FIXTURE_URL,
        timeoutMs: 10000,
      });
      const r = resp.result;
      expect(r).toBeTruthy();
      expect(r.url).toBe(FIXTURE_URL);
      expect(typeof r.innerHTML).toBe('string');
      expect(r.innerHTML).toContain('data-testid="save-btn"');
      expect(r.innerHTML).toContain('<h1>Welcome</h1>');

      // domHash should be a SHA-256 hex digest of innerHTML.
      const expected = createHash('sha256').update(r.innerHTML).digest('hex');
      expect(r.domHash).toBe(expected);
      expect(r.domHash).toMatch(/^[0-9a-f]{64}$/);

      // screenshotBase64 must decode to a non-empty PNG (first 8 bytes
      // are the PNG magic: 89 50 4e 47 0d 0a 1a 0a).
      const png = Buffer.from(r.screenshotBase64, 'base64');
      expect(png.length).toBeGreaterThan(100);
      expect(png.slice(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      expect(typeof r.capturedAt).toBe('string');
      // ISO-8601 parse check.
      expect(Number.isNaN(Date.parse(r.capturedAt))).toBe(false);
    },
    120_000,
  );

  it(
    'does NOT disturb the recording-session state.page (author browser is separate)',
    async () => {
      // Launch a recording browser first, then snapshot: the recording
      // page must still exist unaffected.
      await sidecar.call('launch', {
        viewport: { width: 800, height: 600 },
        theme: 'auto',
        headless: true,
      });
      await sidecar.call('goto', { url: FIXTURE_URL });
      // Take the author-time snapshot (should use a separate browser).
      const snap = await sidecar.call('captureSnapshot', { url: FIXTURE_URL });
      expect(snap.result.url).toBe(FIXTURE_URL);
      // Recording-session assertions still work — proves state.page survived.
      const present = await sidecar.call('assert', {
        target: { kind: 'selector', value: '[data-testid="save-btn"]' },
      });
      expect(present.result.ok).toBe(true);
    },
    120_000,
  );
});
