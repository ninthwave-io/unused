// A genuine orphan — the config-root keep-alive must not blanket the repo, so
// this still flags high.
export function dead(): string {
  return "dead";
}
