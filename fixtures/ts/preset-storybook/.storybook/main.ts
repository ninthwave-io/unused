import type { StorybookConfig } from "@storybook/react-vite";

// Storybook auto-discovers every file matched by this `stories` glob at dev/build
// time — none is ever statically imported by application code, by design. The
// storybook preset reads this glob directly (the hidden `.storybook` directory is
// not part of the discovered source set — the same bespoke-carrier shape vite's
// index.html uses) and seeds every match as a production entrypoint. The `@(ts|tsx)`
// extglob alternation is rewritten to `{ts,tsx}` for the shared glob compiler.
const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
