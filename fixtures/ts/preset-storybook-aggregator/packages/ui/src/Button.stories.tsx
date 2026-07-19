import { Button } from "./Button.js";

// A story in @agg/ui, a package with NO Storybook config or dependency of its
// own. It is auto-discovered by the host package's aggregator `stories` glob
// (`../../packages/*/src/**/*.stories.@(ts|tsx)`) and seeded as a production
// entrypoint — flagging it (or Button) would be a false positive.
export default { component: Button };
export const Default = {};
