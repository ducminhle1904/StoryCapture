const assert = require("node:assert/strict");

const addonPath = process.argv[2];
if (!addonPath) throw new Error("native addon path is required");
const addon = require(addonPath);
assert.equal(addon.protocolVersion, 1);
assert.equal(typeof addon.createSession, "function");
assert.throws(
  () =>
    addon.createSession({
      width: 1,
      height: 1,
      ffmpegPath: "/invalid",
      outputPath: "/invalid",
    }),
  /1920x1080/,
);
process.stdout.write(`Loaded shared-texture probe addon protocol ${addon.protocolVersion}\n`);
