// Fooling input (reviewer): a file one directory down whose computed import
// prefix is `../`. Resolved against `src/index.ts` this collapses to the repo
// root, so the hazard must scope the WHOLE package — not an unmatchable `./`
// prefix that would leave `sibling.ts` a high-confidence claim.
async function load(name: string): Promise<{ run: () => string }> {
  return import(`../${name}.js`);
}

load("sibling").then((m) => console.log(m.run()));
