/** Compiled-in Elixir runtime conventions prepared from one compiler trace. */

import type { ConventionPlugin } from "./types.js";

export const elixirRuntimeConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:elixir-runtime",
  version: "0.1.0",
  languages: ["ex"],
  applies(context) {
    return context.fragment.deferredContributions?.has(this.id) === true;
  },
  async analyze(context) {
    return context.fragment.deferredContributions?.get(this.id) ?? {};
  },
};
