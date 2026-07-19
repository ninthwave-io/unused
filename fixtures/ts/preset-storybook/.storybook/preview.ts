import { withThemeDecorator } from "../src/storybookOnly.js";

// A Storybook preview config. `discover.ts` descends the otherwise-hidden
// `.storybook` directory and analyze.ts seeds this file as a `config`
// reachability root, so its import of an application helper keeps that helper
// alive: a module referenced ONLY by a `.storybook` config file is genuinely
// used (Storybook loads it) and must never be flagged dead — a confident false
// positive this closes.
export const decorators = [withThemeDecorator];
