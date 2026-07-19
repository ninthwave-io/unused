// @refs/lib is a `composite` project REFERENCED by @refs/app's tsconfig, but has
// no `references` of its own (a referenced leaf). Its files may be consumed
// across the project boundary by projects this single analysis does not see, so
// a dead-looking export cannot be proven dead at HIGH confidence — the
// referenced-unit project-references cap holds it at medium.
export function usedLib(): number {
  return 1;
}

export function deadLib(): number {
  return 2;
}
