// Production entrypoint (@fix/app's package.json `main`). Reaches `widget`
// ONLY through this member's own `tsconfig.json#paths` "@/*" -> "./*" alias —
// the near-universal Next.js "@/ maps to the app root" convention. The alias
// lives in packages/app/tsconfig.json, NOT the (absent) monorepo-root tsconfig,
// so before T4.6 the single root-bound resolver never saw it and widget.ts was
// flagged as an orphaned false positive. With the per-member resolver, "@/..."
// resolves internally and widget.ts is correctly kept alive.
import { Widget } from "@/components/widget";

export function render(): string {
  return new Widget().label();
}
