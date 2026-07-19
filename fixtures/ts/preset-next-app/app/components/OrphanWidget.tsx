// An ordinary component sitting alongside Next's route tree — its filename
// matches none of the App Router convention names, and nothing imports it.
// Must stay claimable: the "next" preset's entrypoint patterns are
// convention-filename-specific, not "everything under app/**" (reviewer
// fix, presets.ts: "so an ordinary component placed alongside a route stays
// claimable").
export function OrphanWidget(): JSX.Element {
  return <div>orphan</div>;
}
