// An App Router API route handler — endpoint-reserved: alive and never
// claimable, the same way any other production entrypoint's exports are
// (T2.4's surface-live rule), with no separate mechanism needed.
export function GET(): Response {
  return new Response("hello");
}
