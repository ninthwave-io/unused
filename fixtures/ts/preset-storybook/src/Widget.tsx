// A component kept alive ONLY by its story (Widget.stories.tsx) — no application
// code imports it. Under the storybook preset the story is a production
// entrypoint, so Widget is live, exactly as a reference implementation's
// storybook plugin keeps a story-only component alive.
export function Widget(): null {
  return null;
}
