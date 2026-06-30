const modernGlob = require("glob-modern");

function glob(pattern, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  modernGlob.glob(pattern, options ?? {}).then(
    (matches) => callback?.(null, matches),
    (error) => callback?.(error),
  );
}

glob.glob = glob;
glob.sync = (pattern, options) => modernGlob.globSync(pattern, options ?? {});
glob.globSync = glob.sync;
glob.hasMagic = modernGlob.hasMagic;
glob.escape = modernGlob.escape;
glob.unescape = modernGlob.unescape;

module.exports = glob;
