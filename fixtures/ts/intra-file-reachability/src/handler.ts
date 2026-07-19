// The aws-lambda cluster shape, minimised. `handle` (production-alive via
// index.ts) references sibling exports within this same file — `getProcessor`
// directly, and `Processor` only through the private `processor` binding. None
// are imported by any other file's production code, so before the intra-file
// reachability fix they were mis-claimed test-only (a test imports
// `getProcessor`) / unused. They must all read as alive.
export class Processor {
  run(): number {
    return 1;
  }
}

// Private module-scope binding: the indirection `getProcessor` → `processor`
// → `Processor` the fix must trace through (Processor has no direct exported
// referrer).
const processor = new Processor();

export const getProcessor = (_event: string): Processor => processor;

export const handle = (event: string): number => getProcessor(event).run();

// Genuinely dead: referenced by nothing (production or test). Recall baseline —
// proves the fix keeps only *actually-referenced* siblings alive, not the whole
// file.
export const deadHelper = (): number => 2;
