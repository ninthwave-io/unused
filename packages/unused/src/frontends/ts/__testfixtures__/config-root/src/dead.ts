// A genuine orphan: not an entrypoint, not a config, not referenced anywhere.
// Must still be flagged — the config-root keep-alive must not blanket the repo.
export function dead(): string {
  return "dead";
}
