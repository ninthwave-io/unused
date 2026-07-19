// No vite.config.* here — the "vite" devDependency alone must be enough to
// auto-activate the preset (T4.4 item 1, the dependency-marker arm) and seed
// this file via index.html.
export function mount(): void {
  console.log("mounted");
}
