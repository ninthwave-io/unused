// A `.js` config root. Its `setupFiles` entry is a STRING path, not an import —
// the string-reference scan over config-root source must keep test-setup alive
// (probe P3: config path references in .js/.ts configs, not just .json).
module.exports = {
  setupFiles: ["./src/test-setup.js"],
};
