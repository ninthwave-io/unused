// Sits at the package root; reachable only through `import(`../${name}.js`)`
// from src/index.ts. Must be capped medium (whole-package scope), not high.
export function run(): string {
  return "sibling";
}
