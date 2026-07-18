// Reachable via the "." condition of package.json "exports".
import { helperA } from "./shared.js";

console.log(helperA());
