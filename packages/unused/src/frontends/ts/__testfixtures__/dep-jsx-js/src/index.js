// A `.js` source under an automatic-runtime tsconfig (`jsx: react-jsx`): CRA-style
// projects put JSX in `.js`/`.mjs`, so `react` must be kept alive whenever the
// automatic runtime is configured and any source file exists — not only for
// `.tsx`/`.jsx` files. `unused-dep` is genuinely unused and is claimed.
export const App = () => null;
