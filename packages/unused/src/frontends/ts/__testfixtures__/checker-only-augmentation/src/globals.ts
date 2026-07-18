// `Marker` is referenced only through the declaration merge below (`marker: Marker`)
// — a checker-only relationship with no import/export edge. Without the
// `checker-only-type-relationship` hazard it would be a confident dead export.
export interface Marker {
  id: string;
}

declare global {
  interface Window {
    marker: Marker;
  }
}
