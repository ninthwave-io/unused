// Reachable ONLY via the root tsconfig's `@root/*` alias from app.ts. Alive iff
// root-owned files resolve through the root tsconfig — the "root files still use
// root tsconfig" half of the T4.6 fix.
export function rootWidget(): string {
  return "root-widget";
}
