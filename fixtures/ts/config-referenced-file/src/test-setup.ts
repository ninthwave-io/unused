// The only mention of this file anywhere is the string path in
// jest.config.json's "setupFiles" array — that is config data, not a parsed
// import edge, so no TS/JS file ever imports test-setup.ts directly.
export function configureEnvironment(): void {
  process.env.FIXTURE_MODE = "test";
}

configureEnvironment();
