// A genuinely dead file: no importer, aliased or otherwise. It proves the fix
// keeps real orphans flaggable at HIGH confidence — the member still gets a
// clean claim here, so the alias fix suppresses only the truly-live widget.ts,
// not the whole package.
export function neverImported(): string {
  return "dead";
}
