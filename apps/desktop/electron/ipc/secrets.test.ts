import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: {
    getPath: vi.fn(),
  },
  safeStorage: {
    decryptString: vi.fn((value: Buffer) => value.toString("utf8").replace(/^encrypted:/, "")),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, "utf8")),
    isEncryptionAvailable: vi.fn(() => true),
  },
}));

vi.mock("electron", () => electronMock);

import { secretsHandlers } from "./secrets";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-secrets-test-"));
  electronMock.app.getPath.mockImplementation((name: string) => {
    if (name !== "userData") throw new Error(`Unexpected app path: ${name}`);
    return tempDir;
  });
});

afterEach(async () => {
  electronMock.app.getPath.mockReset();
  electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(true);
  await fs.rm(tempDir, { force: true, recursive: true });
});

describe("generic secret IPC handlers", () => {
  it("stores, loads, and deletes generic secrets", async () => {
    await expect(
      secretsHandlers.store_secret({
        service: "storycapture",
        key: "api-token",
        value: "secret-value",
      }),
    ).resolves.toBeNull();

    await expect(
      secretsHandlers.load_secret({
        service: "storycapture",
        key: "api-token",
      }),
    ).resolves.toBe("secret-value");

    await expect(
      secretsHandlers.delete_secret({
        service: "storycapture",
        key: "api-token",
      }),
    ).resolves.toBeNull();
    await expect(
      secretsHandlers.load_secret({
        service: "storycapture",
        key: "api-token",
      }),
    ).rejects.toThrow("secret not found");
  });

  it("accepts account as an alias for key", async () => {
    await secretsHandlers.store_secret({
      service: "storycapture",
      account: "account-token",
      value: "account-secret",
    });

    await expect(
      secretsHandlers.load_secret({
        service: "storycapture",
        account: "account-token",
      }),
    ).resolves.toBe("account-secret");
  });

  it("preserves validation errors", async () => {
    await expect(
      secretsHandlers.store_secret({
        service: "",
        key: "api-token",
        value: "secret-value",
      }),
    ).rejects.toThrow("secret service required");
    await expect(
      secretsHandlers.store_secret({
        service: "storycapture",
        key: "api-token",
        value: "",
      }),
    ).rejects.toThrow("secret value required");

    electronMock.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(
      secretsHandlers.store_secret({
        service: "storycapture",
        key: "api-token",
        value: "secret-value",
      }),
    ).rejects.toThrow("OS keychain is unavailable on this host");
  });
});
