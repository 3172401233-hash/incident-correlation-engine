export { correlate } from './engine.js';
export { DependencyGraph } from './graph.js';
export { dedupeAndMerge, fingerprint, ruleMatches } from './dedup.js';
export {
  buildClusters,
  directionConsistency,
  DEFAULT_CORRELATION_OPTIONS,
} from './cluster.js';
export { rankRootCandidates } from './rootcause.js';
export {
  toMillis,
  normalizeAlert,
  gapBetween,
  startDelta,
} from './time.js';
