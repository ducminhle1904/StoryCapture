import { Buffer } from "node:buffer";
import { safeStorage } from "electron";
import { readJson, writeJson } from "./json-store";
import { userDataPath } from "./paths";

interface GenericSecretStore {
  version: number;
  keys: Record<string, string>;
}

function genericSecretStorePath(): string {
  return userDataPath("generic-secrets.v1.json");
}

function genericSecretKey(service: unknown, account: unknown): string {
  const serviceName = String(service ?? "").trim();
  const accountName = String(account ?? "").trim();
  if (!serviceName) throw new Error("secret service required");
  if (!accountName) throw new Error("secret account required");
  return `${Buffer.from(serviceName, "utf8").toString("base64url")}.${Buffer.from(accountName, "utf8").toString("base64url")}`;
}

function assertSafeStorage(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain is unavailable on this host");
  }
}

async function readGenericSecretStore(): Promise<GenericSecretStore> {
  return readJson<GenericSecretStore>(genericSecretStorePath(), {
    version: 1,
    keys: {},
  });
}

async function writeGenericSecretStore(
  store: GenericSecretStore,
): Promise<void> {
  await writeJson(genericSecretStorePath(), {
    version: 1,
    keys: store.keys ?? {},
  });
}

export async function storeGenericSecret(
  service: unknown,
  account: unknown,
  value: unknown,
): Promise<null> {
  assertSafeStorage();
  const secretValue = String(value ?? "");
  if (!secretValue) throw new Error("secret value required");
  const store = await readGenericSecretStore();
  store.keys[genericSecretKey(service, account)] = safeStorage
    .encryptString(secretValue)
    .toString("base64");
  await writeGenericSecretStore(store);
  return null;
}

export async function loadGenericSecret(
  service: unknown,
  account: unknown,
): Promise<string> {
  assertSafeStorage();
  const encrypted = (await readGenericSecretStore()).keys[
    genericSecretKey(service, account)
  ];
  if (!encrypted) throw new Error("secret not found");
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

export async function deleteGenericSecret(
  service: unknown,
  account: unknown,
): Promise<null> {
  const store = await readGenericSecretStore();
  const key = genericSecretKey(service, account);
  delete store.keys[key];
  await writeGenericSecretStore(store);
  return null;
}

export async function loadOptionalGenericSecret(
  service: unknown,
  account: unknown,
): Promise<string | null> {
  try {
    return await loadGenericSecret(service, account);
  } catch {
    return null;
  }
}
