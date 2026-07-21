function assertJsonNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError("Canonical JSON does not allow non-finite numbers.");
  }
}

function canonicalizeValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assertJsonNumber(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON cannot encode cyclic values.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("Canonical JSON cannot encode sparse arrays.");
        items.push(canonicalizeValue(value[index], seen));
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
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key], seen)}`);
    return `{${properties.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** RFC 8785 JSON Canonicalization Scheme for JSON-compatible values. */
export function canonicalizeRecordingCertificationJson(value: unknown): string {
  return canonicalizeValue(value, new Set());
}
