// Fooling input (reviewer): a ROOT-level file with a computed import whose
// static prefix is `./`. Resolved against the root importer this collapses to
// the repo root, so the hazard must scope the WHOLE package — not an
// unmatchable `./` prefix that would leave `mod.ts` a high-confidence claim.
async function load(name: string): Promise<{ run: () => string }> {
  return import(`./${name}.js`);
}

load("mod").then((m) => console.log(m.run()));
