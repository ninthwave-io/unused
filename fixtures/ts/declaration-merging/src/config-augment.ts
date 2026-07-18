// `export {}` marks this file as a module (rather than an ambient script) so
// the `declare module` block below augments the existing "./config.js"
// module instead of declaring a brand-new one.
export {};

// Declaration merging: this augmentation adds `port` onto the SAME `Config`
// interface declared in ./config.ts. TypeScript's checker merges the two
// declarations into a single type — a relationship that exists only at the
// type-checker level, with no import/export edge tying this specific member
// to any consumer. An analyzer that only tracks syntactic import/export
// edges has no edge proving this file's contribution is used.
declare module "./config.js" {
  interface Config {
    port: number;
  }
}
