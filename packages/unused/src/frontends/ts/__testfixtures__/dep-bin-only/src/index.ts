// Neither dependency is imported here. `some-cli`'s installed manifest declares
// a `bin` (materialized by the test into node_modules — gitignored), so it is a
// CLI kept alive; `dead-lib` declares no bin and is claimed unused.
export const value: number = 1;
