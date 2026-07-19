// A Next.js metadata-route generator — invoked by filename convention, no
// import edge. Must stay alive (reviewer fix: previously flagged unused/high).
export default function sitemap(): { url: string }[] {
  return [{ url: "https://example.com" }];
}
