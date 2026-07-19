// Suppressed via unused.config.jsonc, but still discovered and parsed. Its
// computed dynamic import remains a hazard annotation in the reference graph.
async function loadMod(name: string): Promise<{ run: () => string }> {
  return import(`./mods/${name}.js`);
}

loadMod("alpha").then((mod) => console.log(mod.run()));
