// pkg-a's entrypoint deliberately does not reach dormant-loader.ts. A dynamic
// loader in dead code cannot execute and must not lower the package's claims.
export function used(): number {
  return 1;
}
