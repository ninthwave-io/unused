// A genuine orphan: no story renders it and no file imports it. The storybook
// preset must NOT keep it alive — an over-broad keep-alive (e.g. treating every
// component as story-reachable) would be a recall bug. With no hazard in scope it
// is claimed dead at high confidence.
export function Orphan(): null {
  return null;
}
