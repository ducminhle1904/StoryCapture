import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSystemFontCatalog,
  clearSystemFontCatalogCache,
  currentSystemFontCatalogResult,
  filterSystemFontCatalog,
  fontWeightFromFaceStyle,
  loadSystemFontCatalog,
  shouldFallbackSystemFont,
  systemFontIsAvailable,
} from "./system-font-catalog";

const faces = [
  {
    family: "Acme Sans",
    fullName: "Acme Sans Bold",
    postscriptName: "AcmeSans-Bold",
    style: "Bold",
  },
  {
    family: "Acme Sans",
    fullName: "Acme Sans Bold Duplicate",
    postscriptName: "AcmeSans-Bold",
    style: "Bold",
  },
  {
    family: "Acme Sans",
    fullName: "Acme Sans Italic",
    postscriptName: "AcmeSans-Italic",
    style: "Italic",
  },
  {
    family: "Beta Mono",
    fullName: "Beta Mono Regular",
    postscriptName: "BetaMono-Regular",
    style: "Regular",
  },
];

describe("system font catalog", () => {
  beforeEach(() => clearSystemFontCatalogCache());

  it("normalizes, deduplicates by PostScript name, groups, and searches deterministically", () => {
    const catalog = buildSystemFontCatalog(faces);

    expect(catalog.faces).toHaveLength(3);
    expect(catalog.families.map((group) => group.family)).toEqual(["Acme Sans", "Beta Mono"]);
    expect(catalog.faces.find((face) => face.postscriptName === "AcmeSans-Bold")).toMatchObject({
      weight: 700,
      style: "normal",
    });
    expect(catalog.faces.find((face) => face.postscriptName === "AcmeSans-Italic")).toMatchObject({
      weight: 400,
      style: "italic",
    });
    expect(filterSystemFontCatalog(catalog, "italic")[0]?.faces).toHaveLength(1);
    expect(filterSystemFontCatalog(catalog, "beta")[0]?.family).toBe("Beta Mono");
  });

  it("reports availability without discarding saved metadata", () => {
    const catalog = buildSystemFontCatalog(faces);
    const selected = catalog.faces.find((face) => face.postscriptName === "AcmeSans-Bold");
    expect(selected).toBeDefined();
    if (!selected) return;
    expect(systemFontIsAvailable(catalog, selected)).toBe(true);
    expect(systemFontIsAvailable(null, selected)).toBe(false);
    expect(selected.postscriptName).toBe("AcmeSans-Bold");
  });

  it("loads only when the caller invokes the user-activation entry point", async () => {
    const queryLocalFonts = vi.fn().mockResolvedValue(faces);
    const result = await loadSystemFontCatalog({ queryLocalFonts } as unknown as Window);

    expect(queryLocalFonts).toHaveBeenCalledOnce();
    expect(result.status).toBe("ready");
    expect(currentSystemFontCatalogResult()).toBe(result);
    const selected = result.status === "ready" ? result.catalog.faces[0] : undefined;
    expect(selected ? shouldFallbackSystemFont(selected) : true).toBe(false);
  });

  it("returns safe unsupported and denied states", async () => {
    await expect(loadSystemFontCatalog({} as Window)).resolves.toMatchObject({
      status: "unsupported",
    });
    const denied = { queryLocalFonts: vi.fn().mockRejectedValue({ name: "NotAllowedError" }) };
    await expect(loadSystemFontCatalog(denied as unknown as Window)).resolves.toMatchObject({
      status: "denied",
    });
    expect(currentSystemFontCatalogResult()?.status).toBe("denied");
    const selected = buildSystemFontCatalog(faces).faces[0];
    expect(selected ? shouldFallbackSystemFont(selected) : false).toBe(true);
  });

  it("normalizes common face weight labels", () => {
    expect(fontWeightFromFaceStyle("Extra Light")).toBe(200);
    expect(fontWeightFromFaceStyle("SemiBold Italic")).toBe(600);
    expect(fontWeightFromFaceStyle("ExtraBold")).toBe(800);
    expect(fontWeightFromFaceStyle("Regular")).toBe(400);
  });
});
