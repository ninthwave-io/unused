/**
 * `core/analysis` — language-agnostic reachability + claim emission (T2.4,
 * phasing.md M2, architecture.md §2/§4).
 *
 * Consumes the reference-graph {@link IRGraph} a frontend emits and produces
 * claims with zero language knowledge (ADR 0003, dependency-cruiser). See
 * {@link ./reachability.js} for the forward walk + `whyReachable` query and
 * {@link ./claims.js} for M2 claim emission (the hazard keep-alive rules).
 */

export {
  ASSUMPTION_SET_VERSION,
  GLOBAL_ASSUMPTIONS,
  type GlobalAssumption,
  renderAssumptionSet,
} from "./assumption-set.js";
export { type DependencyClaimInput, type EmitClaimsInput, emitClaims } from "./claims.js";
export {
  type ConfidenceCap,
  capIsStrongerOrEqual,
  HAZARD_REGISTRY,
  type HazardClassEntry,
  type HazardScope,
  lookupHazard,
} from "./hazard-registry.js";
export {
  type ComputeReachabilityOptions,
  computePartitionedReachability,
  computeReachability,
  type PartitionedReachability,
  type Predecessor,
  type Reachability,
  type WhyReachable,
  whyReachable,
} from "./reachability.js";
export {
  type WhyAliveInput,
  type WhyAliveResult,
  type WhyCandidate,
  type WhyHazard,
  type WhyHop,
  type WhyPath,
  type WhySubjectRef,
  whyAlive,
} from "./why.js";
