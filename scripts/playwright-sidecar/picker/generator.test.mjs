// unit tests for the ranked DSL generator. The 5 cases here
// exercise the escape helper + rank-selection logic with a minimal page
// stub; the real-Chromium integration coverage lives in server.test.mjs.

import { describe, it, expect } from 'vitest';
import { emitDsl, escapeDslString } from './generator.mjs';

function fakeLocator(uniqueCount) {
  return { count: async () => uniqueCount };
}

function fakePage(map) {
  // map: { testid: count, role: count, label: count, text: count }
  return {
    getByTestId: () => fakeLocator(map.testid ?? 0),
    getByRole: () => fakeLocator(map.role ?? 0),
    getByLabel: () => fakeLocator(map.label ?? 0),
    getByText: () => fakeLocator(map.text ?? 0),
  };
}

describe('escapeDslString', () => {
  it('escapes double quotes', () => {
    expect(escapeDslString('Hello "world"')).toBe('Hello \\"world\\"');
  });
  it('escapes backslashes', () => {
    expect(escapeDslString('C:\\x')).toBe('C:\\\\x');
  });
});

describe('emitDsl rank selection', () => {
  it('rank 1 (testid) wins when unique', async () => {
    const page = fakePage({ testid: 1 });
    const result = await emitDsl(page, {
      testId: 'save-btn',
      role: 'button',
      accessibleName: 'Save',
      css: '#x',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click testid "save-btn"');
    expect(result.locator.kind).toBe('testid');
  });

  it('rank 2 (role+name) wins when testid absent and role+name unique', async () => {
    const page = fakePage({ role: 1 });
    const result = await emitDsl(page, {
      role: 'link',
      accessibleName: 'Docs',
      css: '#x',
      tagName: 'A',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click link "Docs"');
    expect(result.locator.kind).toBe('role');
  });

  it('rank 5 (CSS fallback) when all higher ranks fail count()===1', async () => {
    const page = fakePage({ testid: 0, role: 0, label: 0, text: 0 });
    const result = await emitDsl(page, {
      testId: 'duplicate',
      role: 'button',
      accessibleName: 'Dup',
      associatedLabel: 'Dup',
      visibleText: 'Dup',
      css: '.mystery-widget',
      tagName: 'DIV',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click selector ".mystery-widget"');
    expect(result.locator.kind).toBe('selector');
  });
});

describe('emitDsl element metadata forwarding', () => {
  it('attaches `element` metadata when overlay payload includes it', async () => {
    const page = fakePage({ testid: 1 });
    const result = await emitDsl(page, {
      testId: 'email',
      role: 'textbox',
      accessibleName: 'Email',
      css: '#email',
      tagName: 'INPUT',
      shadowDepth: 0,
      inputType: 'email',
      isTextInput: true,
    });
    expect(result.element).toEqual({
      tagName: 'INPUT',
      role: 'textbox',
      accessibleName: 'Email',
      inputType: 'email',
      isTextInput: true,
    });
  });

  it('omits `element` when overlay payload has no metadata fields', async () => {
    const page = fakePage({ testid: 1 });
    const result = await emitDsl(page, {
      testId: 'save',
      css: '#save',
      // tagName intentionally omitted to assert the helper treats it as absent.
      shadowDepth: 0,
    });
    // Phase 1 contract: legacy callers without metadata still get { emitted,
    // locator, candidates } only.
    expect(result.element).toBeUndefined();
  });

  it('forwards optionLabels for select elements', async () => {
    const page = fakePage({ testid: 1 });
    const result = await emitDsl(page, {
      testId: 'country',
      css: '#country',
      tagName: 'SELECT',
      shadowDepth: 0,
      isSelect: true,
      optionLabels: ['USA', 'VN', 'DE'],
    });
    expect(result.element?.isSelect).toBe(true);
    expect(result.element?.optionLabels).toEqual(['USA', 'VN', 'DE']);
  });
});

// ─── Fix #3: handle-equality verification ─────────────────────────────
//
// A locator with count===1 is NOT enough — re-renders can substitute a
// different element under the same selector. The generator now also
// verifies the locator's first match IS the user-clicked element by
// comparing against `window.__sc_pick_target` via evaluateHandle.
//
// We simulate the page+locator surface by hand. Each tier's locator
// returns a fake elementHandle (a plain marker); page.evaluate then
// resolves identity by referential equality between the marker handles.

function makePickPage({ tiers, pickTargetMarker }) {
  // Build a Locator stub that exposes both `count` AND `elementHandles`
  // (the latter is what handle-equality leans on).
  function makeLocator(spec) {
    return {
      count: async () => spec.count,
      elementHandles: async () =>
        spec.handles ?? Array.from({ length: spec.count }, (_, i) => ({ __mark: `${spec.kind}#${i}` })),
    };
  }
  return {
    getByTestId: () => makeLocator(tiers.testid),
    getByRole: () => makeLocator(tiers.role),
    getByLabel: () => makeLocator(tiers.label),
    getByText: () => makeLocator(tiers.text),
    locator: () => makeLocator(tiers.css ?? { kind: 'css', count: 1 }),
    // pickHandle marker — same shape as elementHandles() entries so
    // identity equality works across them.
    evaluateHandle: async (_fn) => ({
      __mark: pickTargetMarker,
      // The generator calls .jsonValue() to detect "no anchor"; returning a
      // truthy non-null value keeps the gate active.
      jsonValue: async () => ({}),
      dispose: async () => {},
    }),
    // identity check via __mark. The generator passes
    // `[pickHandle, handlesArray]` and expects `list.indexOf(target)`.
    evaluate: async (_fn, args) => {
      const [target, list] = args;
      if (!Array.isArray(list) || !target) return -1;
      return list.findIndex((h) => h && h.__mark === target.__mark);
    },
  };
}

describe('emitDsl handle-equality verification (Fix #3)', () => {
  it('rejects testid tier when count===1 but matches a different element', async () => {
    // testid count=1 — but the only handle's marker doesn't match pickTarget.
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 1, handles: [{ __mark: 'OTHER' }] },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] }, // CSS DOES match
      },
    });
    const result = await emitDsl(page, {
      testId: 'save',
      role: 'button',
      accessibleName: 'Save',
      css: '.fallback',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    // Despite testid count===1, equality reject → fall through to CSS.
    expect(result.locator.kind).toBe('selector');
    const testidCandidate = result.candidates.find((c) => c.kind === 'testid');
    expect(testidCandidate).toBeDefined();
    expect(testidCandidate.unique).toBe(true);
    expect(testidCandidate.matches).toBe(false);
  });

  it('accepts testid tier when count===1 AND first handle matches pickTarget', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 1, handles: [{ __mark: 'PICK' }] },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      testId: 'save',
      css: '.fallback',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    expect(result.locator.kind).toBe('testid');
    const tid = result.candidates.find((c) => c.kind === 'testid');
    expect(tid.unique).toBe(true);
    expect(tid.matches).toBe(true);
  });

  it('handle-equality skips when page lacks evaluateHandle (legacy stubs)', async () => {
    // The fakePage in earlier tests has no `evaluateHandle` — the
    // generator's `getPickHandle` returns null and `locatorMatchesPick`
    // bypasses the equality gate. This test asserts that contract.
    const page = fakePage({ testid: 1 });
    const result = await emitDsl(page, {
      testId: 'legacy',
      css: '#x',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    expect(result.locator.kind).toBe('testid');
    // No `matches` field is asserted because legacy code paths set it true
    // when pickHandle is null. We just verify the test still emits.
    expect(result.candidates.find((c) => c.kind === 'testid').unique).toBe(true);
  });
});

// ─── Fix #2: CSS fallback uniqueness verification ─────────────────────
//
// Old behavior: CSS was always unique-by-construction (assumed). New:
// the generator runs isUnique on the CSS locator too — when finder's
// output isn't actually unique under shadow piercing, the candidate is
// flagged so callers can react.

describe('emitDsl CSS uniqueness verification (Fix #2)', () => {
  it('CSS candidate carries unique=true when locator.count() === 1', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 0 },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      css: '#unique',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    const cssCand = result.candidates.find((c) => c.kind === 'selector');
    expect(cssCand.unique).toBe(true);
    expect(cssCand.matches).toBe(true);
    expect(result.locator.kind).toBe('selector');
  });

  it('CSS candidate carries unique=false when locator matches >1 element', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 0 },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        // count=2 → not unique. handles array doesn't matter for this assertion.
        css: { kind: 'css', count: 2, handles: [{ __mark: 'A' }, { __mark: 'B' }] },
      },
    });
    const result = await emitDsl(page, {
      css: '.shared-class',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    const cssCand = result.candidates.find((c) => c.kind === 'selector');
    expect(cssCand.unique).toBe(false);
    expect(cssCand.matches).toBe(false);
    // Still emits the CSS line (last-resort), but the candidate flags
    // surface the brittleness so downstream tooling/UI can warn.
    expect(result.locator.kind).toBe('selector');
    expect(result.emitted).toContain('.shared-class');
  });

  it('CSS uniqueness gate is bypassed for legacy stubs without page.locator', async () => {
    // fakePage lacks `locator` — generator marks css candidate unique=true
    // (preserves the pre-Fix #2 behavior for callers that opted out).
    const page = fakePage({ testid: 0, role: 0, label: 0, text: 0 });
    const result = await emitDsl(page, {
      testId: 'duplicate',
      css: '.legacy-fallback',
      tagName: 'DIV',
      shadowDepth: 0,
    });
    const cssCand = result.candidates.find((c) => c.kind === 'selector');
    expect(cssCand.unique).toBe(true);
    expect(result.locator.kind).toBe('selector');
  });
});

// nth fallback when high-quality tier is non-unique.
//
// When a tier matches multiple elements but the user-clicked element is
// among them, emit `... nth N` (1-indexed) instead of falling through to
// a brittler tier. CSS unchanged — `:nth-of-type` already handles it.

describe('emitDsl nth fallback', () => {
  it('testid count=3, user clicked index 1 → emits nth 2', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: {
          kind: 'testid',
          count: 3,
          handles: [
            { __mark: 'OTHER0' },
            { __mark: 'PICK' },
            { __mark: 'OTHER2' },
          ],
        },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      testId: 'row',
      css: '.fallback',
      tagName: 'DIV',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click testid "row" nth 2');
    expect(result.locator).toEqual({ kind: 'testid', value: 'row', nth: 2 });
    const nthCand = result.candidates.find(
      (c) => c.kind === 'testid' && c.nth !== undefined,
    );
    expect(nthCand).toBeDefined();
    expect(nthCand.unique).toBe(false);
    expect(nthCand.matches).toBe(true);
    expect(nthCand.nth).toBe(2);
  });

  it('role count=2, user clicked second → emits nth 2', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 0 },
        role: {
          kind: 'role',
          count: 2,
          handles: [{ __mark: 'OTHER' }, { __mark: 'PICK' }],
        },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      role: 'button',
      accessibleName: 'Save',
      css: '.fallback',
      tagName: 'BUTTON',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click button "Save" nth 2');
    // nth lives at the top level of `locator`, NOT inside `value`.
    expect(result.locator.kind).toBe('role');
    expect(result.locator.value).toEqual({ role: 'button', name: 'Save' });
    expect(result.locator.nth).toBe(2);
  });

  it('label count=2, user clicked first → emits nth 1 (1-indexed boundary)', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 0 },
        role: { kind: 'role', count: 0 },
        label: {
          kind: 'label',
          count: 2,
          handles: [{ __mark: 'PICK' }, { __mark: 'OTHER' }],
        },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      associatedLabel: 'Email',
      css: '.fallback',
      tagName: 'INPUT',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click field "Email" nth 1');
    expect(result.locator).toEqual({ kind: 'label', value: 'Email', nth: 1 });
  });

  it('count>1 but no handle matches across all tiers → falls through to CSS', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: {
          kind: 'testid',
          count: 3,
          handles: [
            { __mark: 'OTHER0' },
            { __mark: 'OTHER1' },
            { __mark: 'OTHER2' },
          ],
        },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      testId: 'row',
      css: '.real-anchor',
      tagName: 'DIV',
      shadowDepth: 0,
    });
    expect(result.locator.kind).toBe('selector');
    expect(result.locator.nth).toBeUndefined();
    // The original (non-nth) testid candidate is recorded; no nth-fallback
    // candidate was pushed because identity match failed for every handle.
    const nthCand = result.candidates.find(
      (c) => c.kind === 'testid' && c.nth !== undefined,
    );
    expect(nthCand).toBeUndefined();
  });

  it('count===1 path doesn\'t regress (no nth postfix on unique tier)', async () => {
    const page = makePickPage({
      pickTargetMarker: 'PICK',
      tiers: {
        testid: { kind: 'testid', count: 1, handles: [{ __mark: 'PICK' }] },
        role: { kind: 'role', count: 0 },
        label: { kind: 'label', count: 0 },
        text: { kind: 'text', count: 0 },
        css: { kind: 'css', count: 1, handles: [{ __mark: 'PICK' }] },
      },
    });
    const result = await emitDsl(page, {
      testId: 'row',
      css: '.fallback',
      tagName: 'DIV',
      shadowDepth: 0,
    });
    expect(result.emitted).toBe('click testid "row"');
    expect(result.locator).toEqual({ kind: 'testid', value: 'row' });
    expect(result.locator.nth).toBeUndefined();
  });
});
