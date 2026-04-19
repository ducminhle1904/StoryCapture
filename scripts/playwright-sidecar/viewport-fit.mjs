export const VIEWPORT_FIT_MAX_ATTEMPTS = 5;
export const VIEWPORT_FIT_SETTLE_MS = 50;

function intOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * Compute the next outer window bounds required to make the page's inner
 * viewport match `target`. Returns the residual delta and whether the fit is
 * already exact.
 */
export function nextWindowBoundsForViewport(bounds, inner, target) {
  const targetWidth = intOrZero(target?.width);
  const targetHeight = intOrZero(target?.height);
  const innerWidth = intOrZero(inner?.w ?? inner?.width);
  const innerHeight = intOrZero(inner?.h ?? inner?.height);
  const boundsWidth = intOrZero(bounds?.width);
  const boundsHeight = intOrZero(bounds?.height);

  const deltaWidth = targetWidth - innerWidth;
  const deltaHeight = targetHeight - innerHeight;
  const done = deltaWidth === 0 && deltaHeight === 0;

  return {
    done,
    targetWidth,
    targetHeight,
    innerWidth,
    innerHeight,
    boundsWidth,
    boundsHeight,
    deltaWidth,
    deltaHeight,
    nextBounds: done
      ? null
      : {
          width: Math.max(1, boundsWidth + deltaWidth),
          height: Math.max(1, boundsHeight + deltaHeight),
        },
  };
}
