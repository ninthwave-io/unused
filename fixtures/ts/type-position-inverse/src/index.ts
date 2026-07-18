// Value-position import syntax, but Point is only ever used in a type
// annotation below — the FP trap: an analyzer that only tracks value-level
// usage would wrongly see zero "real" uses of Point.
import { Point } from "./types.js";

function distanceFromOrigin(p: Point): number {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

console.log(distanceFromOrigin({ x: 3, y: 4 }));
