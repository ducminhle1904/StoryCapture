function normalizedHttpNavigationUrl(
  rawUrl: string | null | undefined,
): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function sameNavigationUrl(
  currentUrl: string,
  targetUrl: string,
): boolean {
  const current = normalizedHttpNavigationUrl(currentUrl);
  const target = normalizedHttpNavigationUrl(targetUrl);
  return current !== null && target !== null && current === target;
}
