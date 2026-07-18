// Not under ./mods/, and no dynamic-import hazard is anywhere near this file:
// a plain, unambiguously dead export.
export function neverUsed(): void {
  console.log("truly unreferenced");
}
