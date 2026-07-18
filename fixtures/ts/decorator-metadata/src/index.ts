import { usedElsewhere } from "./other.js";
// Side-effect import: brings service.ts's module into the reachability graph
// (a DI module registration) without naming `Service`.
import "./service.js";

export function boot(): void {
  console.log(usedElsewhere());
}
