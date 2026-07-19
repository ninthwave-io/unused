// @refs/lib's public barrel (package.json "main"). It re-exports only `usedLib`
// — `deadLib` (in ./api) is not part of the public surface here.
export { usedLib } from "./api.js";
