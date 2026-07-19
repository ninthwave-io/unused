// Automatic JSX runtime (`jsx: react-jsx`): this file compiles to an import of
// `react/jsx-runtime` that never appears in source. `react` is therefore used
// with no visible import — the classic dependency false positive the
// jsx-runtime-dependency keep-alive prevents.
export const App = () => <div>hello</div>;
