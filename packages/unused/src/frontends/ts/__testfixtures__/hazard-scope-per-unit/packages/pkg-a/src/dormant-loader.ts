// A fully opaque computed require, carried by a file no root or live edge reaches.
// The annotation remains available for provenance, but cannot affect claims.
export function loadPlugin(moduleName: string): unknown {
  return require(moduleName);
}
