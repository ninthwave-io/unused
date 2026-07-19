import { Widget } from "./Widget.js";

// A Storybook story file: auto-discovered via `.storybook/main.ts`'s `stories`
// glob (`../src/**/*.stories.@(ts|tsx)`), never statically imported by any app
// code. The storybook preset seeds it as a production entrypoint, so it — and
// the Widget it renders — is alive.
export default { component: Widget };
export const Default = {};
