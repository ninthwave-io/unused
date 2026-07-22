/**
 * Hazard-registry unit tests (T3.1). Assert the closed vocabulary is fully
 * covered, each class in this task's group has the scope/cap the corpus and the
 * PRD §4 confidence contract expect, and the defensive `lookupHazard` fallback
 * that backs the degrade-toward-alive invariant.
 */
import { describe, expect, it } from "vitest";
import type { HazardClass } from "../ir/index.js";
import {
  capIsStrongerOrEqual,
  HAZARD_REGISTRY,
  type HazardClassEntry,
  lookupHazard,
} from "./hazard-registry.js";

const ALL_CLASSES: readonly HazardClass[] = [
  "computed-dynamic-import",
  "computed-require",
  "computed-cjs-exports",
  "config-referenced-file",
  "unresolvable-import",
  "outside-project",
  "internal-declaration",
  "declaration-companion",
  "parse-error",
  "import-equals",
  "export-assignment",
  "checker-only-type-relationship",
  "emit-decorator-metadata",
  "conditional-exports-divergence",
  "project-references",
  "unresolvable-entrypoint-target",
  "jsx-runtime-dependency",
  "bin-only-dependency",
  "config-named-dependency",
  "capacitor-platform-dependency",
  "elixir-behaviour-callback",
  "elixir-dynamic-dispatch",
  "elixir-phoenix-runtime",
  "elixir-script-opaque",
  "rustler-ambiguous-registration",
];

describe("HAZARD_REGISTRY — vocabulary coverage", () => {
  it("has an entry for every closed hazard class, keyed consistently, with a rationale", () => {
    for (const cls of ALL_CLASSES) {
      const entry = HAZARD_REGISTRY[cls];
      expect(entry, cls).toBeDefined();
      expect(entry.hazardClass, cls).toBe(cls);
      expect(entry.rationale.length, cls).toBeGreaterThan(0);
    }
    // No stray keys beyond the closed vocabulary.
    expect(Object.keys(HAZARD_REGISTRY).sort()).toEqual([...ALL_CLASSES].sort());
  });
});

describe("HAZARD_REGISTRY — scope/cap per class group (T3.1a)", () => {
  const expectEntry = (cls: HazardClass, part: Partial<HazardClassEntry>): void => {
    expect(HAZARD_REGISTRY[cls]).toMatchObject(part);
  };

  it("computed import/require are carrier-activated directory-subtree caps", () => {
    expectEntry("computed-dynamic-import", {
      scope: "directory-subtree",
      cap: "medium",
      activation: "carrier-reachable",
    });
    expectEntry("computed-require", {
      scope: "directory-subtree",
      cap: "medium",
      activation: "carrier-reachable",
    });
  });

  it("computed-cjs-exports is symbol-set, cap medium (exports capped, file liveness free)", () => {
    expectEntry("computed-cjs-exports", { scope: "symbol-set", cap: "medium" });
  });

  it("config-referenced-file is file scope, cap medium", () => {
    expectEntry("config-referenced-file", { scope: "file", cap: "medium" });
  });

  it("parse-error is file scope, no-claim", () => {
    expectEntry("parse-error", { scope: "file", cap: "no-claim" });
  });

  it("unresolvable-import / outside-project / declaration edges / CJS-interop are scope none", () => {
    for (const cls of [
      "unresolvable-import",
      "outside-project",
      "internal-declaration",
      "declaration-companion",
      "import-equals",
      "export-assignment",
    ] as const) {
      expect(HAZARD_REGISTRY[cls].scope, cls).toBe("none");
    }
  });

  it("checker-only-type-relationship is symbol-set, no-claim (declaration merging keeps exports alive)", () => {
    expectEntry("checker-only-type-relationship", { scope: "symbol-set", cap: "no-claim" });
  });

  it("emit-decorator-metadata is symbol-set, cap medium (decorated file's exports capped)", () => {
    expectEntry("emit-decorator-metadata", { scope: "symbol-set", cap: "medium" });
  });

  it("conditional-exports-divergence is file scope, no-claim (non-selected branch kept alive)", () => {
    expectEntry("conditional-exports-divergence", { scope: "file", cap: "no-claim" });
  });

  it("project-references is directory-subtree, cap medium (whole-package, conservative)", () => {
    expectEntry("project-references", { scope: "directory-subtree", cap: "medium" });
  });

  it("unresolvable-entrypoint-target is project scope, cap medium (whole-package, unbuilt-entry safe)", () => {
    expectEntry("unresolvable-entrypoint-target", { scope: "project", cap: "medium" });
  });

  it("jsx-runtime-dependency is scope none (activates at M4)", () => {
    expect(HAZARD_REGISTRY["jsx-runtime-dependency"].scope).toBe("none");
    expect(HAZARD_REGISTRY["jsx-runtime-dependency"].rationale).toMatch(/M4/);
  });

  it("the M4 dependency keep-alive rationales are scope none (no claim effect)", () => {
    // T4.1: bin-only and config-named are dependency-liveness keep-alive
    // rationales — they never emit or cap a claim (a kept-alive dependency is
    // simply not claimed), they document why a declared dependency is spared.
    expect(HAZARD_REGISTRY["bin-only-dependency"].scope).toBe("none");
    expect(HAZARD_REGISTRY["config-named-dependency"].scope).toBe("none");
  });

  it("dynamic runtime hazards follow their carriers; all other hazards remain always active", () => {
    expect(HAZARD_REGISTRY["elixir-dynamic-dispatch"].activation).toBe("carrier-reachable");
    expect(HAZARD_REGISTRY["rustler-ambiguous-registration"].activation).toBe("carrier-reachable");
    for (const [cls, entry] of Object.entries(HAZARD_REGISTRY)) {
      if (
        cls === "computed-dynamic-import" ||
        cls === "computed-require" ||
        cls === "elixir-dynamic-dispatch" ||
        cls === "rustler-ambiguous-registration"
      ) {
        continue;
      }
      expect(entry.activation, cls).toBe("always");
    }
  });

  it("standalone script uncertainty is scoped to that file at medium", () => {
    expectEntry("elixir-script-opaque", {
      scope: "file",
      cap: "medium",
      activation: "always",
    });
  });
});

describe("lookupHazard — defensive fallback", () => {
  it("returns the entry for a registered class", () => {
    expect(lookupHazard("computed-require")?.scope).toBe("directory-subtree");
  });

  it("returns undefined for any class outside the closed vocabulary", () => {
    expect(lookupHazard("not-a-real-hazard")).toBeUndefined();
    expect(lookupHazard("")).toBeUndefined();
    // Not fooled by inherited Object properties.
    expect(lookupHazard("toString")).toBeUndefined();
    expect(lookupHazard("constructor")).toBeUndefined();
  });
});

describe("capIsStrongerOrEqual — ordering for multi-hazard subjects", () => {
  it("orders no-claim > low > medium, reflexively", () => {
    expect(capIsStrongerOrEqual("no-claim", "medium")).toBe(true);
    expect(capIsStrongerOrEqual("no-claim", "low")).toBe(true);
    expect(capIsStrongerOrEqual("low", "medium")).toBe(true);
    expect(capIsStrongerOrEqual("medium", "medium")).toBe(true);
    expect(capIsStrongerOrEqual("medium", "low")).toBe(false);
    expect(capIsStrongerOrEqual("low", "no-claim")).toBe(false);
  });
});
