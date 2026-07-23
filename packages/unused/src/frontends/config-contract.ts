/**
 * Language-neutral import surface for the validated repository policy contract.
 *
 * Parsing and matching remain in the original TypeScript frontend module during
 * the pre-v0.1 migration; plugins depend on this surface, not that ownership
 * detail, so the implementation can move without changing the plugin contract.
 */
export type {
  ConfigMatchProjection,
  EntrySymbolLanguage,
  GateThreshold,
  UnusedConfig,
  WorkspaceConfigOverride,
} from "./ts/config.js";
