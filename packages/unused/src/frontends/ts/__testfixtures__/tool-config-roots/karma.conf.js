// A second tool-invoked config root (`karma.conf.js`; note the `.conf.` not
// `.config.`). Loaded by the Karma CLI by filename convention — never claimed.
export default function karma(config) {
  config.set({ frameworks: ["mocha"] });
}
