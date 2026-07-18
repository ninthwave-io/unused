import { formatName } from "./format.js";

export function greet(name: string): string {
  return `Hello, ${formatName(name)}`;
}
