import { shared } from "../lib/src/shared.js";
import { ping } from "./util.js";

export function main(): string {
  return `${shared()} ${ping()}`;
}
