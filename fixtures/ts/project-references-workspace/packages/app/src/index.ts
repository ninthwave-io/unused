import { usedLib } from "@refs/lib";

// The @refs/app entrypoint. It consumes @refs/lib's `usedLib` across the project
// boundary, but NOT `deadLib`.
export function main(): number {
  return usedLib();
}
