// App Router file-based metadata convention — Next generates the sitemap
// from this file with no import edge either. Must be kept alive by the
// "next" preset (presets.ts's APP_METADATA_CONVENTION_FILES).
export default function sitemap(): { url: string }[] {
  return [{ url: "https://example.com" }];
}
