// Sits under the same "@app/*" alias root as util.ts but is never imported,
// aliased or relative, by anything in this fixture.
export function orphanFn(): string {
  return "orphan";
}
