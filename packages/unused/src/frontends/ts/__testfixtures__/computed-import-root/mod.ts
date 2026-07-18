// Reachable only through the root-level computed `import(`./${name}.js`)`. It
// must be capped medium (whole-package scope), never a high-confidence claim.
export function run(): string {
  return "mod";
}
