// Statically unreferenced: reachable only through the computed `file://` import.
// Must be capped medium (whole-package scope), never a high-confidence claim —
// this is the regression the `staticSpecifierPrefix` fix pins.
export function run(): string {
  return "mod";
}
