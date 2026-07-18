// Point is never constructed or referenced as a value anywhere — only ever
// named in a type annotation. UnusedShape is not referenced anywhere at all.
export interface Point {
  x: number;
  y: number;
}

export interface UnusedShape {
  radius: number;
}
