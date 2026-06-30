const fs = require("node:fs");

function toRmOptions(options) {
  const retries = options?.maxRetries ?? options?.maxBusyTries ?? 0;

  return {
    recursive: true,
    force: true,
    maxRetries: retries,
    retryDelay: options?.retryDelay ?? 100,
  };
}

function rimraf(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  fs.rm(path, toRmOptions(options), callback ?? (() => {}));
}

rimraf.sync = (path, options) => {
  fs.rmSync(path, toRmOptions(options));
};

module.exports = rimraf;
