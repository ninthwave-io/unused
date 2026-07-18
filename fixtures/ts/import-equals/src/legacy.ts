// CJS "export =" idiom: replaces the module's entire exported value with a
// single object, rather than exporting named bindings via `export`. This is
// the counterpart TS construct to import-equals — the two only typecheck
// together under non-ESM module settings (see tsconfig.json), which is why
// this fixture pins `module: "CommonJS"` and `verbatimModuleSyntax: false`.
const legacyApi = {
  version: "1.0.0",
};

export = legacyApi;
