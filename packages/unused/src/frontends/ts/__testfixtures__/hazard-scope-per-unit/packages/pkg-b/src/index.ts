// pkg-b's entrypoint. pkg-b has NO dynamic require/import anywhere and no
// dependency on pkg-a.
export function used(): number {
  return 2;
}
