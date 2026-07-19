// No next.config.* here — the "next" dependency alone must be enough to
// auto-activate the preset (T4.4 item 1, the dependency-marker arm) and seed
// this Pages Router file via entryPatterns.
export default function FooPage(): string {
  return "foo";
}
