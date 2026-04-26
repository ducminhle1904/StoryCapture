// ranked DSL generator. Each candidate is verified via
// `locator.count() === 1` before being emitted. Returns the FIRST candidate
// that resolves uniquely. CSS fallback is always available as the last rank.
//
// Wire shape:
//   Input:  PickCandidatePayload (see picker/overlay/index.ts)
//   Output: { emitted: string, locator: { kind, value }, candidates: [...] }
//
// `emitted` is the DSL line the desktop UI inserts at cursor (07-03b
// consumes this byte-for-byte).

// Escape DSL string-literal contents. The DSL grammar uses double-quoted
// strings; backslash and double-quote MUST be escaped so the parser sees
// the literal name back. Forward slash, single quote, etc. need no escape.
export function escapeDslString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function isUnique(locator) {
  try {
    return (await locator.count()) === 1;
  } catch {
    return false;
  }
}

// Element-shape metadata forwarded verbatim from the overlay so the
// desktop picker action menu can promote input-flavored actions
// (fill/type/select/upload) without re-deriving DOM shape on the host.
function pickElementMeta(payload) {
  const keys = [
    'tagName',
    'role',
    'accessibleName',
    'inputType',
    'isContentEditable',
    'isTextInput',
    'isSelect',
    'isFileInput',
    'optionLabels',
  ];
  const meta = {};
  let hasAny = false;
  for (const k of keys) {
    if (payload[k] !== undefined) {
      meta[k] = payload[k];
      hasAny = true;
    }
  }
  return hasAny ? meta : undefined;
}

export async function emitDsl(page, payload) {
  const candidates = [];
  const element = pickElementMeta(payload);
  const wrap = (result) => (element ? { ...result, element } : result);

  // 1. testid — strongest signal, single attempt.
  if (payload.testId) {
    const value = payload.testId;
    const locator = page.getByTestId(value);
    const unique = await isUnique(locator);
    candidates.push({ kind: 'testid', value, score: 1.0, unique });
    if (unique) {
      return wrap({
        emitted: `click testid "${escapeDslString(value)}"`,
        locator: { kind: 'testid', value },
        candidates,
      });
    }
  }

  // 2. role + accessible name.
  if (payload.role && payload.accessibleName) {
    const role = payload.role;
    const name = payload.accessibleName;
    const locator = page.getByRole(role, { name, exact: true });
    const unique = await isUnique(locator);
    candidates.push({
      kind: 'role',
      value: { role, name },
      score: 0.9,
      unique,
    });
    if (unique) {
      return wrap({
        emitted: `click ${role} "${escapeDslString(name)}"`,
        locator: { kind: 'role', value: { role, name } },
        candidates,
      });
    }
  }

  // 3. associated label (form fields).
  if (payload.associatedLabel) {
    const value = payload.associatedLabel;
    const locator = page.getByLabel(value, { exact: true });
    const unique = await isUnique(locator);
    candidates.push({ kind: 'label', value, score: 0.8, unique });
    if (unique) {
      return wrap({
        emitted: `click field "${escapeDslString(value)}"`,
        locator: { kind: 'label', value },
        candidates,
      });
    }
  }

  // 4. exact visible text.
  if (payload.visibleText) {
    const value = payload.visibleText;
    const locator = page.getByText(value, { exact: true });
    const unique = await isUnique(locator);
    candidates.push({ kind: 'text_exact', value, score: 0.5, unique });
    if (unique) {
      return wrap({
        emitted: `click text "${escapeDslString(value)}"`,
        locator: { kind: 'text_exact', value },
        candidates,
      });
    }
  }

  // 5. CSS fallback — always last; no count() verification because finder
  //    output is unique-by-construction (and the user explicitly clicked
  //    the element).
  const css = payload.css || '*';
  candidates.push({ kind: 'selector', value: css, score: 0.1, unique: true });
  return wrap({
    emitted: `click selector "${escapeDslString(css)}"`,
    locator: { kind: 'selector', value: css },
    candidates,
  });
}
