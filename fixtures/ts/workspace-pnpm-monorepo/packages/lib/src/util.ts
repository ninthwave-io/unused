// The "./util" exports-map target (package.json "exports") — a second,
// independent entrypoint condition on the same sibling package as ".".
export function util(): string {
  return "util";
}
