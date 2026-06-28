import path from "node:path";

export const LOCAL_ASSET_SCHEME = "storycapture-asset";
export const LOCAL_ASSET_PROTOCOL = `${LOCAL_ASSET_SCHEME}:`;

export function convertLocalAssetPath(filePath: string): string {
  const value = String(filePath);
  if (/^(?:https?:|data:|blob:|asset:)/i.test(value) || value.startsWith(LOCAL_ASSET_PROTOCOL)) {
    return value;
  }
  return `${LOCAL_ASSET_SCHEME}://local/${encodeURIComponent(value)}`;
}

export function assetPathFromUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== LOCAL_ASSET_PROTOCOL) {
    throw new Error(`unsupported asset protocol: ${parsed.protocol}`);
  }
  return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
}

function normalizedPath(value: string): string {
  return path.resolve(value);
}

export function isPathUnderRoot(filePath: string, rootPath: string): boolean {
  const file = normalizedPath(filePath);
  const root = normalizedPath(rootPath);
  const relative = path.relative(root, file);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isAllowedLocalAssetPath(filePath: string, roots: string[]): boolean {
  return roots.some((root) => root && isPathUnderRoot(filePath, root));
}
