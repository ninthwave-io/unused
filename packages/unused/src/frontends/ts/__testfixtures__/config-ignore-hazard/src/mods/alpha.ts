// Would be capped medium by src/loader.ts's computed-import hazard if that
// file weren't ignored; with it ignored, this is a plain high-confidence
// dead file (a real orphan, nothing references it).
export function alpha(): string {
  return "alpha";
}
