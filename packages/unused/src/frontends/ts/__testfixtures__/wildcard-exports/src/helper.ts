// Nothing imports helper.ts; it is public ONLY through the "./*" wildcard
// export ("./helper" -> "./src/helper.js"). Without wildcard expansion it would
// be a false-positive dead export/file.
export function helper(): string {
  return "helper";
}
