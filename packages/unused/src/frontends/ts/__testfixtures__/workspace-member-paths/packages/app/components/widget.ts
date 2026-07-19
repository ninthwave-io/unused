// Reachable ONLY via the "@/components/widget" alias import in index.ts. Must
// resolve internal (alive) once the member's own tsconfig `paths` is honoured —
// the subject of the M4 smoke "worst finding". No claim should be emitted here.
export class Widget {
  label(): string {
    return "widget";
  }
}
