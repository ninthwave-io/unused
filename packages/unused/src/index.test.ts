import { expectTypeOf, it } from "vitest";
import type { AnalysisBoundary, CompletedAnalysisBoundary } from "./index.js";

it("retains the public schema-1.3 CompletedAnalysisBoundary shape", () => {
  const legacy: CompletedAnalysisBoundary = {
    status: "complete",
    pluginId: "language:neutral",
    boundaryId: "neutral:.",
    language: "neutral",
    fileCount: 1,
    workspaceCount: 1,
  };

  const current: AnalysisBoundary = {
    ...legacy,
    partitions: legacy.partitions ?? {
      production: "complete",
      config: "complete",
      test: "complete",
    },
  };

  expectTypeOf(legacy.status).toEqualTypeOf<"complete">();
  expectTypeOf(legacy.partitions).toEqualTypeOf<
    { production: "complete"; config: "complete"; test: "complete" } | undefined
  >();
  expectTypeOf(current).toMatchTypeOf<AnalysisBoundary>();
});
