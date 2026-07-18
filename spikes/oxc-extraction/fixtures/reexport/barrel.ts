// Barrel: a star re-export plus a named re-export.
// `x` arrives via the star from ./a; only `y` is named-re-exported from ./b (NOT z).
export * from './a.js';
export * from './a2.js'; // second star source -> creates a name-collision hazard for `x`
export { y } from './b.js';
