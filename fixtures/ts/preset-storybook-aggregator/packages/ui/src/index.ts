// The @agg/ui entrypoint (package.json "main"). It does NOT import Button or
// Orphan — their liveness is decided by the host's Storybook aggregator (Button,
// via its story) or by nothing (Orphan).
export const uiVersion = "1.0.0";
