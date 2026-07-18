// The module specifier is a template literal built from a runtime value: static
// analysis cannot enumerate which file(s) under ./mods/ this can resolve to.
async function loadMod(name: string): Promise<{ run: () => string }> {
  return import(`./mods/${name}.js`);
}

loadMod("alpha").then((mod) => console.log(mod.run()));
