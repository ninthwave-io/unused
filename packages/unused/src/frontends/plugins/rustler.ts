/** Built-in Rustler language conventions and Elixir/Rust bridge (ADR 0013). */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  endpointId,
  fileId,
  type HazardAnnotation,
  type IREdge,
  type IRNode,
  symbolId,
} from "../../core/ir/index.js";
import { extractElixirRustlerSource } from "../elixir/rustler.js";
import { extractRustlerRustSource } from "../rust/rustler.js";
import type { BridgePlugin, ConventionPlugin, ConventionPluginContext } from "./types.js";

const PLUGIN_VERSION = "0.1.0";
const RUSTLER_PROTOCOL = "rustler-nif";

export const rustlerElixirConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:rustler-elixir",
  version: PLUGIN_VERSION,
  languages: ["ex"],
  applies(context) {
    return sourceFiles(context, ".ex").length > 0;
  },
  async analyze(context) {
    const nodes: IRNode[] = [];
    const edges: IREdge[] = [];
    const hazards: HazardAnnotation[] = [];
    for (const file of sourceFiles(context, ".ex")) {
      const extraction = extractElixirRustlerSource(file, readSource(context, file));
      for (const site of extraction.ambiguousSites) hazards.push(ambiguityHazard(site));
      const moduleCounts = countBy(extraction.modules.map((loader) => loader.module));
      for (const loader of extraction.modules) {
        if (moduleCounts.get(loader.module) !== 1) {
          hazards.push(ambiguityHazard(loader.site));
          continue;
        }
        for (const stub of loader.stubs) {
          const from = symbolId(file, `${loader.module}.${stub.name}/${stub.arity}`);
          if (!context.fragment.graph.hasNode(from)) {
            hazards.push(ambiguityHazard(stub.site));
            continue;
          }
          const endpoint = rustlerEndpoint(loader.module, stub.name, stub.arity);
          nodes.push(endpoint);
          edges.push({
            kind: "consumes",
            from,
            to: endpoint.id,
            site: stub.site,
            name: `${stub.name}/${stub.arity}`,
          });
        }
      }
    }
    return { nodes, edges, hazards };
  },
};

export const rustlerRustConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:rustler-rust",
  version: PLUGIN_VERSION,
  languages: ["rs"],
  applies(context) {
    return sourceFiles(context, ".rs").length > 0;
  },
  async analyze(context) {
    const nodes: IRNode[] = [];
    const edges: IREdge[] = [];
    const hazards: HazardAnnotation[] = [];
    for (const file of sourceFiles(context, ".rs")) {
      const extraction = extractRustlerRustSource(file, readSource(context, file));
      for (const site of extraction.ambiguousSites) hazards.push(ambiguityHazard(site));
      for (const nif of extraction.nifs) {
        const id = symbolId(file, nif.name);
        if (!context.fragment.graph.hasNode(id)) {
          nodes.push({
            kind: "symbol",
            id,
            file,
            exportedName: nif.name,
            isDefault: false,
            typeOnly: false,
            local: true,
            span: nif.site.span,
          });
          edges.push({
            kind: "contains",
            from: fileId(file),
            to: id,
            site: nif.site,
            name: nif.name,
          });
        }
        if (extraction.registrations.length !== 1) {
          hazards.push(ambiguityHazard(nif.site));
          continue;
        }
        const registration = extraction.registrations[0];
        if (registration === undefined) continue;
        const endpoint = rustlerEndpoint(registration.module, nif.name, nif.arity);
        nodes.push(endpoint);
        edges.push({
          kind: "consumes",
          from: endpoint.id,
          to: id,
          site: nif.site,
          name: `${nif.name}/${nif.arity}`,
        });
      }
    }
    return { nodes, edges, hazards };
  },
};

export const rustlerBridgePlugin: BridgePlugin = {
  kind: "bridge",
  id: "bridge:rustler",
  version: PLUGIN_VERSION,
  // Rust is the only mandatory side: the plugin must still conserve an exact
  // NIF when its BEAM consumer lives outside the analyzed repository.
  requiredLanguages: ["rs"],
  applies(context) {
    return context.graph
      .nodes()
      .some((node) => node.kind === "endpoint" && node.protocol === RUSTLER_PROTOCOL);
  },
  async analyze(context) {
    const edges: IREdge[] = [];
    const endpointIds = new Set(
      context.graph
        .nodes()
        .filter(
          (node): node is Extract<IRNode, { kind: "endpoint" }> =>
            node.kind === "endpoint" && node.protocol === RUSTLER_PROTOCOL,
        )
        .map((node) => node.id),
    );
    for (const endpoint of endpointIds) {
      const incomingElixir = uniqueEdges(
        context.graph
          .edges()
          .filter(
            (edge) =>
              edge.kind === "consumes" &&
              edge.to === endpoint &&
              context.graph.nodeOfKind("symbol", edge.from)?.file.endsWith(".ex") === true,
          ),
        (edge) => edge.from,
      );
      const outgoingRust = uniqueEdges(
        context.graph
          .edges()
          .filter(
            (edge) =>
              edge.kind === "consumes" &&
              edge.from === endpoint &&
              context.graph.nodeOfKind("symbol", edge.to)?.file.endsWith(".rs") === true,
          ),
        (edge) => edge.to,
      );

      if (incomingElixir.length > 0 && outgoingRust.length === 1) {
        const rust = outgoingRust[0];
        if (rust === undefined) continue;
        for (const elixir of incomingElixir) {
          edges.push({
            kind: "references",
            referenceKind: "runtime-resolved",
            from: elixir.from,
            to: rust.to,
            site: elixir.site,
            ...(elixir.name === undefined ? {} : { name: elixir.name }),
          });
        }
        continue;
      }

      // A literal Rustler NIF without one in-repository Elixir endpoint could
      // be called by a separately built BEAM application. Keep that exact
      // symbol alive instead of inferring a closed world from absent source.
      for (const rust of outgoingRust) {
        const target = context.graph.getNode(rust.to);
        if (target?.kind !== "symbol") continue;
        edges.push({
          kind: "references",
          referenceKind: "runtime-resolved",
          from: fileId(target.file),
          to: target.id,
          site: rust.site,
          name: target.exportedName,
        });
      }
    }
    return { edges };
  },
};

function sourceFiles(context: ConventionPluginContext, extension: ".ex" | ".rs"): string[] {
  return [...context.fragment.claimInputs.analysisFiles]
    .filter((file) => file.endsWith(extension))
    .sort();
}

function readSource(context: ConventionPluginContext, file: string): string {
  return readFileSync(resolve(context.repository.rootDir, file), "utf8");
}

function rustlerEndpoint(module: string, name: string, arity: number): IRNode {
  const route = `${module}.${name}/${arity}`;
  return {
    kind: "endpoint",
    id: endpointId(RUSTLER_PROTOCOL, route),
    protocol: RUSTLER_PROTOCOL,
    route,
  };
}

function ambiguityHazard(site: HazardAnnotation["site"]): HazardAnnotation {
  return {
    file: fileId(site.file),
    hazardClass: "rustler-ambiguous-registration",
    detail:
      "Rustler runtime registration is present but its exact module/function/arity pairing cannot be proven",
    site,
  };
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function uniqueEdges(edges: readonly IREdge[], key: (edge: IREdge) => string): IREdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const value = key(edge);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
