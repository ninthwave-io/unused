// Reachable only through the entry's scoped computed dynamic import
// (`./plugins/${name}.js`); no static importer anywhere. Inside the
// hazard's ./plugins/ scope.
export function run(): string {
  return "extra";
}
