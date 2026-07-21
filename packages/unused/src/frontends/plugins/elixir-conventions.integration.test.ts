import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fileId, symbolId } from "../../core/ir/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { analyzeProjectAutoWithGraph } from "../dispatch.js";

const mfaFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/runtime-mfa-callback", import.meta.url),
);
const behaviourFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/behaviour-callback", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!isMixAvailable())("Elixir convention plugin integration", () => {
  it("restores deferred runtime edges and behaviour hazards before global claims", {
    timeout: 120_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-conventions-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "apps"), { recursive: true });
    await Promise.all([
      copyFixture(mfaFixture, join(root, "apps/mfa")),
      copyFixture(behaviourFixture, join(root, "apps/beh")),
    ]);

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    const runtimeTarget = symbolId(
      "apps/mfa/lib/neutral_mfa/callback.ex",
      "NeutralMfa.Callback.callback_name/1",
    );
    expect(analysis.reachability.production.reachableSymbols.has(runtimeTarget)).toBe(true);
    expect(
      analysis.graph
        .edges()
        .some(
          (edge) =>
            edge.referenceKind === "runtime-resolved" &&
            edge.to === runtimeTarget &&
            edge.site.file === "apps/mfa/lib/neutral_mfa/runtime_config.ex",
        ),
    ).toBe(true);
    expect(
      analysis.graph
        .hazards()
        .some(
          (hazard) =>
            hazard.hazardClass === "elixir-behaviour-callback" &&
            hazard.file === fileId("apps/beh/lib/beh/email_handler.ex"),
        ),
    ).toBe(true);
    expect(
      analysis.result.claims.some(
        (claim) =>
          claim.subject.name === "NeutralMfa.Callback.callback_name/1" ||
          claim.subject.name === "Beh.EmailHandler.handle/1",
      ),
    ).toBe(false);
  });
});

async function copyFixture(source: string, target: string): Promise<void> {
  await cp(source, target, {
    recursive: true,
    filter: (path) => !["_build", "deps", ".elixir_ls"].includes(basename(path)),
  });
}
