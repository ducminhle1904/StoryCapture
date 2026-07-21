#!/usr/bin/env node

const path = require("node:path");

const addonPath = process.argv[2];
if (!addonPath) throw new Error("Recording V3 addon path is required");
const addon = require(path.resolve(addonPath));
const probe = addon.probe?.();
if (
  addon.protocolVersion !== 3 ||
  typeof addon.protocolHash !== "string" ||
  addon.protocolHash.length !== 64 ||
  probe?.protocolVersion !== addon.protocolVersion ||
  probe?.protocolHash !== addon.protocolHash ||
  probe?.ioSurface !== true ||
  probe?.nativeFfv1 !== true ||
  typeof addon.start !== "function"
) {
  throw new Error("Recording V3 addon protocol probe failed");
}
process.stdout.write(
  `Recording V3 native addon protocol ${addon.protocolVersion}/${addon.protocolHash} loaded\n`,
);
