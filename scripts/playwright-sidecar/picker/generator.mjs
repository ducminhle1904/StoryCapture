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

// Acquire a handle on the element the overlay stashed in
// `window.__sc_pick_target` BEFORE emitting. Returns null if the page
// doesn't expose `evaluateHandle` (the test stub) or if the target was
// never set — both cases fall back to count-only uniqueness, preserving
// existing test contracts.
async function getPickHandle(page) {
  if (typeof page.evaluateHandle !== "function") return null;
  try {
    const handle = await page.evaluateHandle(() => window.__sc_pick_target);
    // evaluateHandle returns a JSHandle for the resolved value; if the
    // value was null/undefined we treat it as "no anchor" and skip the
    // equality gate.
    const json = await handle.jsonValue().catch(() => undefined);
    if (json === null) {
      try {
        await handle.dispose();
      } catch {}
      return null;
    }
    return handle;
  } catch {
    return null;
  }
}

// Find the 0-based index of the user-clicked element (`pickHandle`) among
// the locator's matches via a single CDP round-trip. Returns:
//   -1 — pickHandle null (test stubs / overlay opt-out), elementHandles()
//        missing, no handles, or no handle equals pickHandle
//   N  — index of the matching handle
//
// All handles are disposed before returning; callers don't own them.
// Errors fall through to -1 so a tier that throws here is just rejected.
async function findHandleIndex(page, locator, pickHandle) {
  if (!pickHandle) return -1;
  if (typeof locator.elementHandles !== "function") return -1;
  let handles;
  try {
    handles = await locator.elementHandles();
    if (handles.length === 0) return -1;
    const idx = await page
      .evaluate(
        ([target, list]) => list.indexOf(target),
        [pickHandle, handles],
      )
      .catch(() => -1);
    return typeof idx === "number" ? idx : -1;
  } catch {
    return -1;
  } finally {
    if (Array.isArray(handles)) {
      for (const h of handles) {
        try {
          await h.dispose();
        } catch {}
      }
    }
  }
}

// True iff the locator's FIRST match is the user-clicked element. Used to
// gate count===1 acceptance against re-render races. Returning true when
// pickHandle is null preserves count-only behavior for legacy test stubs.
async function locatorMatchesPick(page, locator, pickHandle) {
  if (!pickHandle) return true;
  if (typeof locator.elementHandles !== "function") return true;
  return (await findHandleIndex(page, locator, pickHandle)) === 0;
}

// 0-based index of the user-clicked element within the locator's matches,
// or -1. Used to compute `nth` for the multi-match fallback path.
async function findClickedIndex(page, locator, pickHandle) {
  return findHandleIndex(page, locator, pickHandle);
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

  // Acquire a handle on the user-clicked element (overlay stashed it on
  // window.__sc_pick_target before emit). Each tier's primary match is
  // verified against this handle so count===1 alone can't ship a locator
  // that race-conditioned onto a different element after re-render.
  const pickHandle = await getPickHandle(page);
  const accept = async (locator) =>
    (await isUnique(locator)) && (await locatorMatchesPick(page, locator, pickHandle));

  try {
    // 1. testid — strongest signal, single attempt.
    if (payload.testId) {
      const value = payload.testId;
      const locator = page.getByTestId(value);
      const unique = await isUnique(locator);
      const matches = unique
        ? await locatorMatchesPick(page, locator, pickHandle)
        : false;
      candidates.push({ kind: 'testid', value, score: 1.0, unique, matches });
      if (unique && matches) {
        return wrap({
          emitted: `click testid "${escapeDslString(value)}"`,
          locator: { kind: 'testid', value },
          candidates,
        });
      }
      // nth fallback: tier matched multiple elements but the user's element
      // is among them — emit `... nth N` (1-indexed) instead of falling
      // through to a brittler tier.
      if (!unique) {
        const idx = await findClickedIndex(page, locator, pickHandle);
        if (idx >= 0) {
          const nth = idx + 1;
          candidates.push({
            kind: 'testid',
            value,
            score: 0.95,
            unique: false,
            matches: true,
            nth,
          });
          return wrap({
            emitted: `click testid "${escapeDslString(value)}" nth ${nth}`,
            locator: { kind: 'testid', value, nth },
            candidates,
          });
        }
      }
    }

    // 2. role + accessible name.
    if (payload.role && payload.accessibleName) {
      const role = payload.role;
      const name = payload.accessibleName;
      const locator = page.getByRole(role, { name, exact: true });
      const unique = await isUnique(locator);
      const matches = unique
        ? await locatorMatchesPick(page, locator, pickHandle)
        : false;
      candidates.push({
        kind: 'role',
        value: { role, name },
        score: 0.9,
        unique,
        matches,
      });
      if (unique && matches) {
        return wrap({
          emitted: `click ${role} "${escapeDslString(name)}"`,
          locator: { kind: 'role', value: { role, name } },
          candidates,
        });
      }
      if (!unique) {
        const idx = await findClickedIndex(page, locator, pickHandle);
        if (idx >= 0) {
          const nth = idx + 1;
          candidates.push({
            kind: 'role',
            value: { role, name },
            score: 0.85,
            unique: false,
            matches: true,
            nth,
          });
          return wrap({
            emitted: `click ${role} "${escapeDslString(name)}" nth ${nth}`,
            locator: { kind: 'role', value: { role, name }, nth },
            candidates,
          });
        }
      }
    }

    // 3. associated label (form fields).
    if (payload.associatedLabel) {
      const value = payload.associatedLabel;
      const locator = page.getByLabel(value, { exact: true });
      const unique = await isUnique(locator);
      const matches = unique
        ? await locatorMatchesPick(page, locator, pickHandle)
        : false;
      candidates.push({ kind: 'label', value, score: 0.8, unique, matches });
      if (unique && matches) {
        return wrap({
          emitted: `click field "${escapeDslString(value)}"`,
          locator: { kind: 'label', value },
          candidates,
        });
      }
      if (!unique) {
        const idx = await findClickedIndex(page, locator, pickHandle);
        if (idx >= 0) {
          const nth = idx + 1;
          candidates.push({
            kind: 'label',
            value,
            score: 0.75,
            unique: false,
            matches: true,
            nth,
          });
          return wrap({
            emitted: `click field "${escapeDslString(value)}" nth ${nth}`,
            locator: { kind: 'label', value, nth },
            candidates,
          });
        }
      }
    }

    // 4. exact visible text.
    if (payload.visibleText) {
      const value = payload.visibleText;
      const locator = page.getByText(value, { exact: true });
      const unique = await isUnique(locator);
      const matches = unique
        ? await locatorMatchesPick(page, locator, pickHandle)
        : false;
      candidates.push({ kind: 'text_exact', value, score: 0.5, unique, matches });
      if (unique && matches) {
        return wrap({
          emitted: `click text "${escapeDslString(value)}"`,
          locator: { kind: 'text_exact', value },
          candidates,
        });
      }
      if (!unique) {
        const idx = await findClickedIndex(page, locator, pickHandle);
        if (idx >= 0) {
          const nth = idx + 1;
          candidates.push({
            kind: 'text_exact',
            value,
            score: 0.45,
            unique: false,
            matches: true,
            nth,
          });
          return wrap({
            emitted: `click text "${escapeDslString(value)}" nth ${nth}`,
            locator: { kind: 'text_exact', value, nth },
            candidates,
          });
        }
      }
    }

    // 5. CSS fallback. Verify uniqueness AND handle-equality just like the
    //    higher tiers — `@medv/finder` output isn't actually unique under
    //    `>>` shadow-piercing when multiple shadow hosts share a path.
    const css = payload.css || '*';
    const cssLocator = typeof page.locator === 'function' ? page.locator(css) : null;
    let cssUnique = true;
    let cssMatches = true;
    if (cssLocator) {
      cssUnique = await isUnique(cssLocator);
      cssMatches = cssUnique
        ? await locatorMatchesPick(page, cssLocator, pickHandle)
        : false;
    }
    candidates.push({
      kind: 'selector',
      value: css,
      score: 0.1,
      unique: cssUnique,
      matches: cssMatches,
    });
    return wrap({
      emitted: `click selector "${escapeDslString(css)}"`,
      locator: { kind: 'selector', value: css },
      candidates,
    });
  } finally {
    if (pickHandle) {
      try {
        await pickHandle.dispose();
      } catch {}
    }
  }
}
