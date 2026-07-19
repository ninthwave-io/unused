// A dynamic App Router route — the [slug] directory segment is ordinary
// glob text to the entry-pattern matcher (no special dynamic-segment
// handling needed: `app/**/page.{js,jsx,ts,tsx}` already matches any depth).
export default function BlogPostPage(): string {
  return "post";
}
