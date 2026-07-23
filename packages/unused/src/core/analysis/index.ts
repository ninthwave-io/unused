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
export {
  type ClaimEmissionContext,
  createClaimEmissionContext,
  type DependencyClaimInput,
  type EmitClaimsInput,
  emitClaims,
} from "./claims.js";
export {
  type ComputeDeletionPlanInput,
  computeDeletionPlan,
  createDeletionPlanningContext,
  type DeletionPlan,
  type DeletionPlanConsequenceSubject,
  type DeletionPlanningContext,
  type DeletionPlanStage,
  type DeletionPlanSubject,
  type ReExportEdit,
  surfaceNameHasUniqueOrigin,
} from "./deletion-plan.js";
export {
  type AppliedHazardCap,
  createHazardEvaluationContext,
  effectsForSubject,
  evaluateHazards,
  type HazardEvaluation,
  type HazardEvaluationContext,
  type HazardEvaluationInput,
  type HazardSubject,
} from "./hazard-evaluation.js";
export {
  type ConfidenceCap,
  capIsStrongerOrEqual,
  HAZARD_REGISTRY,
  type HazardActivation,
  type HazardClassEntry,
  type HazardPropagation,
  type HazardScope,
  lookupHazard,
} from "./hazard-registry.js";
export {
  PERFORMANCE_PHASES,
  type PerformanceCounters,
  type PerformanceMemorySnapshot,
  type PerformancePhase,
  type PerformancePhaseEvent,
  type PerformanceSnapshot,
  PerformanceTracker,
  performanceMemorySnapshot,
} from "./performance.js";
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
