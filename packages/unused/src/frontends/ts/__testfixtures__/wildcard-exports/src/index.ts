// Public via the "./*" wildcard export. Imports nothing — its liveness is the
// wildcard entrypoint, not an inbound import.
export function index(): string {
  return "index";
}
