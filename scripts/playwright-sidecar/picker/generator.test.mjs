// Plan 07-03a — unit tests for the ranked DSL generator. The 5 cases here
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
