// Outside the ./plugins/ hazard scope entirely, and never imported —
// statically or dynamically — by anything in this fixture.
export function summarize(): string {
  return "report";
}
