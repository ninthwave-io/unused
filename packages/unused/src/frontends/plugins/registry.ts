/** Deterministic static plugin registry (ADR 0013, delivery milestone P1). */

import type {
  AnalyzerPlugin,
  BridgePlugin,
  ConventionPlugin,
  LanguageFrontendPlugin,
  PluginKind,
} from "./types.js";

const PLUGIN_ID_RE = /^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/u;

export class PluginRegistry {
  private readonly byId = new Map<string, AnalyzerPlugin>();

  constructor(plugins: readonly AnalyzerPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: AnalyzerPlugin): void {
    if (!PLUGIN_ID_RE.test(plugin.id)) {
      throw new Error(
        `invalid plugin id ${JSON.stringify(plugin.id)}; use lowercase namespaced ids such as language:typescript`,
      );
    }
    if (plugin.version.trim() === "") throw new Error(`plugin ${plugin.id} has an empty version`);
    if (this.byId.has(plugin.id)) throw new Error(`duplicate plugin id: ${plugin.id}`);
    this.byId.set(plugin.id, plugin);
  }

  get(id: string): AnalyzerPlugin | undefined {
    return this.byId.get(id);
  }

  plugins(): readonly AnalyzerPlugin[] {
    return [...this.byId.values()].sort(byId);
  }

  languagePlugins(): readonly LanguageFrontendPlugin[] {
    return this.ofKind("language");
  }

  conventionPlugins(): readonly ConventionPlugin[] {
    return this.ofKind("convention");
  }

  bridgePlugins(): readonly BridgePlugin[] {
    return this.ofKind("bridge");
  }

  private ofKind<K extends PluginKind>(kind: K): readonly Extract<AnalyzerPlugin, { kind: K }>[] {
    return this.plugins().filter(
      (plugin): plugin is Extract<AnalyzerPlugin, { kind: K }> => plugin.kind === kind,
    );
  }
}

function byId(a: AnalyzerPlugin, b: AnalyzerPlugin): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
