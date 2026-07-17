import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maxmind = vi.hoisted(() => ({
  country: vi.fn(),
  existsSync: vi.fn(),
  open: vi.fn(),
}));

vi.mock("fs", () => ({ existsSync: maxmind.existsSync }));
vi.mock("@maxmind/geoip2-node", () => ({
  Reader: { open: maxmind.open },
}));

describe("getCountry", () => {
  beforeEach(() => {
    vi.resetModules();
    maxmind.country.mockReset();
    maxmind.existsSync.mockReset();
    maxmind.open.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lazily opens the database and returns the country code", async () => {
    maxmind.existsSync.mockReturnValue(true);
    maxmind.country.mockReturnValue({ country: { isoCode: "CA" } });
    maxmind.open.mockResolvedValue({ country: maxmind.country });
    const { getCountry } = await import("./geo");

    await expect(getCountry("142.1.1.1, 10.0.0.1")).resolves.toBe("CA");
    await expect(getCountry("142.1.1.1")).resolves.toBe("CA");

    expect(maxmind.open).toHaveBeenCalledTimes(1);
    expect(maxmind.country).toHaveBeenCalledWith("142.1.1.1");
  });

  it("returns XX and caches a missing database", async () => {
    maxmind.existsSync.mockReturnValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getCountry } = await import("./geo");

    await expect(getCountry("142.1.1.1")).resolves.toBe("XX");
    await expect(getCountry("142.1.1.2")).resolves.toBe("XX");

    expect(maxmind.existsSync).toHaveBeenCalledTimes(1);
    expect(maxmind.open).not.toHaveBeenCalled();
  });

  it("returns XX and does not retry after the database cannot be opened", async () => {
    maxmind.existsSync.mockReturnValue(true);
    maxmind.open.mockRejectedValue(new Error("invalid database"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getCountry } = await import("./geo");

    await expect(getCountry("142.1.1.1")).resolves.toBe("XX");
    await expect(getCountry("142.1.1.2")).resolves.toBe("XX");

    expect(maxmind.open).toHaveBeenCalledTimes(1);
  });
});
