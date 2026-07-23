/** Shared ownership and ordering rules for plugin diagnostics. */

import type { Site } from "../../core/ir/index.js";
import { prefixRepositoryPath } from "./rebase.js";
import type { GraphContribution, PluginDiagnostic } from "./types.js";

export type ContributionDiagnosticOwner =
  | {
      readonly scope: "boundary";
      readonly pluginId: string;
      readonly boundaryId: string;
    }
  | {
      readonly scope: "repository";
      readonly pluginId: string;
    };

/** Replace plugin-supplied attribution with the invocation's trusted owner. */
export function normalizeContributionDiagnostic(
  diagnostic: PluginDiagnostic,
  owner: ContributionDiagnosticOwner,
): PluginDiagnostic {
  return {
    pluginId: owner.pluginId,
    ...(owner.scope === "boundary" ? { boundaryId: owner.boundaryId } : {}),
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.site === undefined
      ? {}
      : { site: validateRepositoryDiagnosticSite(diagnostic.site) }),
  };
}

function validateRepositoryDiagnosticSite(site: Site): Site {
  const file = prefixRepositoryPath("", site.file);
  return file === site.file ? site : { ...site, file };
}

/** Collect diagnostics only when their graph contribution is actually applied. */
export class RepositoryDiagnosticAccumulator {
  private readonly diagnostics: PluginDiagnostic[] = [];

  add(contribution: GraphContribution, owner: ContributionDiagnosticOwner): void {
    for (const diagnostic of contribution.diagnostics ?? []) {
      this.diagnostics.push(normalizeContributionDiagnostic(diagnostic, owner));
    }
  }

  values(): readonly PluginDiagnostic[] {
    return [...this.diagnostics];
  }
}

/** Stable code-unit order across frontend, convention, bridge, and policy diagnostics. */
export function comparePluginDiagnostics(a: PluginDiagnostic, b: PluginDiagnostic): number {
  return (
    compareCodeUnits(a.boundaryId ?? "", b.boundaryId ?? "") ||
    compareCodeUnits(a.pluginId, b.pluginId) ||
    compareCodeUnits(a.code, b.code) ||
    compareCodeUnits(a.severity, b.severity) ||
    compareCodeUnits(a.message, b.message) ||
    compareCodeUnits(a.site?.file ?? "", b.site?.file ?? "") ||
    (a.site?.span.start ?? -1) - (b.site?.span.start ?? -1) ||
    (a.site?.span.end ?? -1) - (b.site?.span.end ?? -1) ||
    (a.site?.span.startLine ?? -1) - (b.site?.span.startLine ?? -1) ||
    (a.site?.span.endLine ?? -1) - (b.site?.span.endLine ?? -1)
  );
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
