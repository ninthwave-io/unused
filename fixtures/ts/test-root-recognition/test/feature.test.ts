import { computeFeature } from "../src/feature.js";

// Not a real test-runner call (no vitest/jest dependency in this minimal
// fixture) — just a reference that exercises the import, matching the
// zero-config `*.test.*` basename / root `test/` directory convention the
// analyzer treats as a test reachability root (M3-interim; the full tier-2
// test-only verdict is M5).
const result = computeFeature(2);
if (result !== 4) throw new Error("unexpected");
