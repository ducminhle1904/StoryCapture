import bundledAssetManifest from "../../../../../../assets/bundled-asset-manifest.json";
import type { EditorBackgroundKind } from "./store";

const BUNDLED_BACKGROUND_ID_BY_STEM = new Map(
  bundledAssetManifest.assets.map((asset) => {
    const file = asset.path.split("/").at(-1) ?? asset.path;
    return [file.replace(/\.[a-z0-9]+$/i, ""), asset.assetId] as const;
  }),
);

function decodedPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Recover the stable bundled id from both source URLs and Vite-built URLs.
 * Vite appends an eight-or-more character content hash before the extension.
 */
export function bundledBackgroundAssetIdFromPath(path: string): string | null {
  const clean = decodedPath(path).split(/[?#]/, 1)[0] ?? "";
  const file = clean.split(/[\\/]/).at(-1) ?? "";
  const rawStem = file.replace(/\.[a-z0-9]+$/i, "");
  const unhashedStem = rawStem.replace(/-[a-z0-9_]{8,}$/i, "");
  return (
    BUNDLED_BACKGROUND_ID_BY_STEM.get(rawStem) ??
    BUNDLED_BACKGROUND_ID_BY_STEM.get(unhashedStem) ??
    null
  );
}

export function normalizeEditorBackgroundAsset(
  background: EditorBackgroundKind,
): EditorBackgroundKind {
  if (background.kind !== "image" || background.assetId) return background;
  const assetId = bundledBackgroundAssetIdFromPath(background.path);
  return assetId ? { ...background, assetId } : background;
}
