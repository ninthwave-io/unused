// Ignored via unused.config.jsonc's "ignore" — never discovered, never
// parsed. Its computed dynamic import below must therefore never become a
// hazard annotation, so it cannot cap src/mods/** at medium.
async function loadMod(name: string): Promise<{ run: () => string }> {
  return import(`./mods/${name}.js`);
}

loadMod("alpha").then((mod) => console.log(mod.run()));
