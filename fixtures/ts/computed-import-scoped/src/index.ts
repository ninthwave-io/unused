// Static PREFIX dynamic import: only the trailing segment (`name`) is a
// runtime value; the leading "./plugins/" segment is a string literal. A
// scoped hazard registry entry (architecture §4 "scope of effect") is
// expected to record the plausible-target set as the ./plugins/ directory
// only, not the whole project.
async function loadPlugin(name: string): Promise<{ run: () => string }> {
  return import(`./plugins/${name}.js`);
}

loadPlugin("extra").then((mod) => console.log(mod.run()));
