import { used } from "./util.js";
// Side-effect import brings the `declare global` augmentation into the program.
import "./globals.js";

export function run(): number {
  return used();
}
