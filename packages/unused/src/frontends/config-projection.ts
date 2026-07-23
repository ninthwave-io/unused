/** Configuration facts retained across repository fragment composition. */

import {
  collectConfiguredSymbolRoots,
  configuredSymbolSelectorInventory,
} from "./config-symbol-entrypoints.js";
import type { FrontendConfigContribution } from "./plugins/types.js";
import {
  type ConfigUnit,
  computeBoundaryAnalysisFingerprint,
  type EntrySymbolLanguage,
  projectConfigMatchInventory,
  type UnusedConfig,
} from "./ts/config.js";

export function createFrontendConfigContribution(
  config: UnusedConfig,
  units: readonly ConfigUnit[],
  language: EntrySymbolLanguage,
  scopedFiles: readonly string[],
  options: {
    readonly presetsShadowed?: boolean;
  } = {},
): FrontendConfigContribution {
  const analysis = computeBoundaryAnalysisFingerprint(config, options);
  return {
    analysisFingerprint: analysis.fingerprint,
    hasEffectiveAnalysisPolicy: analysis.hasEffectivePolicy,
    configuredSymbolRoots: collectConfiguredSymbolRoots(config, units, { language }),
    configuredSymbolSelectorInventory: configuredSymbolSelectorInventory(config),
    configMatchInventory: projectConfigMatchInventory(config, scopedFiles, units),
    ...(config.gate === undefined ? {} : { localGateThreshold: config.gate.threshold }),
    ...(config.ciSecondsPerTestFile === undefined
      ? {}
      : { localCiSecondsPerTestFile: config.ciSecondsPerTestFile }),
  };
}
