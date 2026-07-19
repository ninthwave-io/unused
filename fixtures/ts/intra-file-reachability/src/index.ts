// Production entrypoint: re-exports `handle` only. `getProcessor`/`Processor`
// are NOT part of the surface index re-exports — they are alive solely because
// `handle`'s body uses them intra-file (directly, and through a private
// module-scope binding).
export { handle } from "./handler.js";
