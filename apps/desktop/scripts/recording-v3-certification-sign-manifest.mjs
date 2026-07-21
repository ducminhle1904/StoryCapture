import { createHash, createPrivateKey, sign } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  return [
    "Usage: node scripts/recording-v3-certification-sign-manifest.mjs",
    "  --payload <manifest-payload.json>",
    "  --private-key <ed25519-private-key.pem>",
    "  --output <signed-manifest.json>",
  ].join("\n");
}

function parseArgs(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--payload", "--private-key", "--output"].includes(key)) {
      throw new Error(`Unknown argument: ${key}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    options[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ["payload", "private-key", "output"]) {
    if (!options[required]) throw new Error(`Missing --${required}.\n${usage()}`);
  }
  return {
    payloadPath: path.resolve(options.payload),
    privateKeyPath: path.resolve(options["private-key"]),
    outputPath: path.resolve(options.output),
  };
}

function canonicalize(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object")
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
  if (seen.has(value)) throw new TypeError("Canonical JSON cannot encode cyclic values.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("Canonical JSON rejects sparse arrays.");
        items.push(canonicalize(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("Canonical JSON cannot encode symbol properties.");
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

async function writeAtomic(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

export async function signRecordingV3CertificationManifest(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (
    options.privateKeyPath === options.outputPath ||
    options.privateKeyPath === options.payloadPath ||
    options.outputPath === options.payloadPath
  ) {
    throw new Error("Payload, private key, and signed-manifest output must be separate files.");
  }
  const privateKeyStat = await fs.stat(options.privateKeyPath);
  if ((privateKeyStat.mode & 0o077) !== 0) {
    throw new Error("Ed25519 private-key file must not be accessible by group or other users.");
  }
  const payload = JSON.parse(await fs.readFile(options.payloadPath, "utf8"));
  if (
    payload?.canonicalization !== "RFC8785" ||
    payload?.signature_algorithm !== "ed25519" ||
    typeof payload?.signer_key_id !== "string" ||
    payload.signer_key_id.length === 0
  ) {
    throw new Error(
      "Manifest payload has invalid canonicalization, signature algorithm, or signer key ID.",
    );
  }
  const canonicalPayload = canonicalize(payload);
  const privateKey = createPrivateKey(await fs.readFile(options.privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Manifest signing requires an Ed25519 private key.");
  }
  const signature = sign(null, Buffer.from(canonicalPayload), privateKey).toString("base64");
  await writeAtomic(options.outputPath, `${JSON.stringify({ payload, signature }, null, 2)}\n`);
  const summary = {
    signer_key_id: payload.signer_key_id,
    signature_algorithm: "ed25519",
    canonicalization: "RFC8785",
    payload_sha256: createHash("sha256").update(canonicalPayload).digest("hex"),
    output: options.outputPath,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  signRecordingV3CertificationManifest().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
