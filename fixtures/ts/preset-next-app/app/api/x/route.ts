// App Router API route handler — invoked by Next's router by filename
// convention, never imported. Being seeded as a production entrypoint is
// already sufficient for "kept alive, never claimable" (presets.ts module
// doc: no separate endpoint-reservation mechanism needed).
export function GET(): Response {
  return new Response("ok");
}
