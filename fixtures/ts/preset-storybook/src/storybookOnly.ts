// Imported ONLY by .storybook/preview.ts (a Storybook config file), never by any
// application code — yet genuinely used by the Storybook build, so it must stay
// alive. Kept reachable through the `.storybook` config root; flagging it would
// be a false positive on live code.
export function withThemeDecorator(): null {
  return null;
}
