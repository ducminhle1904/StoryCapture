import type { TextFontChoice } from "./timeline-slice";

interface LocalFontFaceData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

type WindowWithLocalFonts = Window & {
  queryLocalFonts?: () => Promise<readonly LocalFontFaceData[]>;
};

export type SystemTextFontChoice = Extract<TextFontChoice, { kind: "system" }>;

export interface SystemFontFamilyGroup {
  family: string;
  faces: SystemTextFontChoice[];
}

export interface SystemFontCatalog {
  faces: SystemTextFontChoice[];
  families: SystemFontFamilyGroup[];
  postscriptNames: ReadonlySet<string>;
}

export type SystemFontCatalogResult =
  | { status: "ready"; catalog: SystemFontCatalog }
  | { status: "unsupported"; message: string }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

let cachedSystemFontCatalogResult: SystemFontCatalogResult | null = null;

function rememberSystemFontCatalogResult(result: SystemFontCatalogResult): SystemFontCatalogResult {
  cachedSystemFontCatalogResult = result;
  return result;
}

export function currentSystemFontCatalogResult(): SystemFontCatalogResult | null {
  return cachedSystemFontCatalogResult;
}

export function clearSystemFontCatalogCache(): void {
  cachedSystemFontCatalogResult = null;
}

export async function loadSystemFontCatalog(
  windowRef: Window = window,
): Promise<SystemFontCatalogResult> {
  const queryLocalFonts = (windowRef as WindowWithLocalFonts).queryLocalFonts;
  if (typeof queryLocalFonts !== "function") {
    return rememberSystemFontCatalogResult({
      status: "unsupported",
      message: "System font access is unavailable. StoryCapture will use Geist.",
    });
  }

  try {
    const faces = await queryLocalFonts.call(windowRef);
    return rememberSystemFontCatalogResult({
      status: "ready",
      catalog: buildSystemFontCatalog(faces),
    });
  } catch (error) {
    if (isPermissionDenied(error)) {
      return rememberSystemFontCatalogResult({
        status: "denied",
        message: "System font access was denied. StoryCapture will use Geist.",
      });
    }
    return rememberSystemFontCatalogResult({
      status: "error",
      message: "System fonts could not be loaded. StoryCapture will use Geist.",
    });
  }
}

export function buildSystemFontCatalog(faces: readonly LocalFontFaceData[]): SystemFontCatalog {
  const byPostscriptName = new Map<string, SystemTextFontChoice>();
  for (const face of faces) {
    const normalized = normalizeSystemFontFace(face);
    if (!normalized) continue;
    const key = normalized.postscriptName.toLocaleLowerCase();
    if (!byPostscriptName.has(key)) byPostscriptName.set(key, normalized);
  }

  const normalizedFaces = [...byPostscriptName.values()].sort(compareFaces);
  const grouped = new Map<string, SystemTextFontChoice[]>();
  for (const face of normalizedFaces) {
    const group = grouped.get(face.family) ?? [];
    group.push(face);
    grouped.set(face.family, group);
  }

  return {
    faces: normalizedFaces,
    families: [...grouped.entries()]
      .map(([family, familyFaces]) => ({ family, faces: familyFaces }))
      .sort((a, b) => compareText(a.family, b.family)),
    postscriptNames: new Set(normalizedFaces.map((face) => face.postscriptName)),
  };
}

export function filterSystemFontCatalog(
  catalog: SystemFontCatalog,
  query: string,
): SystemFontFamilyGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return catalog.families;
  return catalog.families.flatMap((group) => {
    const familyMatches = group.family.toLocaleLowerCase().includes(normalizedQuery);
    const faces = familyMatches
      ? group.faces
      : group.faces.filter((face) =>
          [face.fullName, face.postscriptName, face.faceStyle].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          ),
        );
    return faces.length > 0 ? [{ family: group.family, faces }] : [];
  });
}

export function systemFontIsAvailable(
  catalog: SystemFontCatalog | null,
  font: TextFontChoice | undefined,
): boolean {
  if (!font || font.kind !== "system") return true;
  return catalog?.postscriptNames.has(font.postscriptName) ?? false;
}

export function shouldFallbackSystemFont(font: TextFontChoice): boolean {
  if (font.kind !== "system" || cachedSystemFontCatalogResult === null) return false;
  return (
    cachedSystemFontCatalogResult.status !== "ready" ||
    !systemFontIsAvailable(cachedSystemFontCatalogResult.catalog, font)
  );
}

export function normalizeSystemFontFace(face: LocalFontFaceData): SystemTextFontChoice | null {
  if (!nonEmpty(face.family) || !nonEmpty(face.fullName) || !nonEmpty(face.postscriptName)) {
    return null;
  }
  const faceStyle = nonEmpty(face.style) ? face.style.trim() : "Regular";
  return {
    kind: "system",
    family: face.family.trim(),
    fullName: face.fullName.trim(),
    postscriptName: face.postscriptName.trim(),
    faceStyle,
    weight: fontWeightFromFaceStyle(faceStyle, face.fullName),
    style: /\b(italic|oblique)\b/i.test(`${faceStyle} ${face.fullName}`) ? "italic" : "normal",
  };
}

export function fontWeightFromFaceStyle(faceStyle: string, fullName = ""): number {
  const value = `${faceStyle} ${fullName}`.toLocaleLowerCase().replace(/[\s_-]+/g, " ");
  if (/\b(thin|hairline)\b/.test(value)) return 100;
  if (/\b(extra light|ultra light|extralight|ultralight)\b/.test(value)) return 200;
  if (/\b(light)\b/.test(value)) return 300;
  if (/\b(medium)\b/.test(value)) return 500;
  if (/\b(semi bold|demi bold|semibold|demibold)\b/.test(value)) return 600;
  if (/\b(extra bold|ultra bold|extrabold|ultrabold)\b/.test(value)) return 800;
  if (/\b(black|heavy)\b/.test(value)) return 900;
  if (/\b(bold)\b/.test(value)) return 700;
  return 400;
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "NotAllowedError" || error.name === "SecurityError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        ((error as { name?: unknown }).name === "NotAllowedError" ||
          (error as { name?: unknown }).name === "SecurityError");
}

function compareFaces(a: SystemTextFontChoice, b: SystemTextFontChoice): number {
  return (
    compareText(a.family, b.family) ||
    a.weight - b.weight ||
    compareText(a.style, b.style) ||
    compareText(a.fullName, b.fullName) ||
    compareText(a.postscriptName, b.postscriptName)
  );
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
