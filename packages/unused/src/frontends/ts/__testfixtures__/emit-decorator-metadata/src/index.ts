// Side-effect import keeps service.ts alive (a DI module registration); nothing
// imports `Service` by name — a container instantiates it via decorator metadata.
import "./service.js";

export function boot(): void {
  // noop
}
