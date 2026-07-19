import type { StorybookConfig } from "@storybook/react-vite";

// A "Storybook host" package: it renders stories that live in SIBLING packages,
// via a glob that escapes its own package. The storybook preset rebases this
// glob repo-root-relative and seeds the sibling matches wherever they land, so
// the sibling's story (in a package with no Storybook marker of its own) stays
// alive rather than being flagged dead.
const config: StorybookConfig = {
  stories: ["../../packages/*/src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
};

export default config;
