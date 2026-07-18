// Outside the "./src/*" wildcard subtree and imported by nothing: a genuine
// dead file that MUST still be flagged (the fix must not blanket-keep-alive).
export function dead(): string {
  return "dead";
}
