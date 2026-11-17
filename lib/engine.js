// 告警关联引擎入口：归一化 -> 去重合并 -> 抑制 -> 聚类 -> 根因评分。

import { DependencyGraph } from './graph.js';
import { dedupeAndMerge } from './dedup.js';
import { buildClusters, DEFAULT_CORRELATION_OPTIONS } from './cluster.js';
import { rankRootCandidates } from './rootcause.js';

export function correlate(input = {}, options = {}) {
  const config = {
    ...DEFAULT_CORRELATION_OPTIONS,
    offsets: input.clockOffsets ?? {},
    fingerprintLabels: options.fingerprintLabels,
    suppressionRules: input.suppressionRules ?? [],
    suppressLabelKey: options.suppressLabelKey ?? 'maintenance',
    ...options,
  };

  const graph = new DependencyGraph(input.dependencyGraph ?? { services: [], edges: [] });
  for (const alert of input.alerts ?? []) {
    if (alert.service) graph.addNode(alert.service);
  }

  const merged = dedupeAndMerge(input.alerts ?? [], config);
  const clusters = buildClusters(merged, graph, config);
  for (const cluster of clusters) {
    cluster.rootCandidates = rankRootCandidates(cluster, graph);
  }

  return {
    generatedAt: new Date().toISOString(),
    options: {
      timeWindowMs: config.timeWindowMs,
      maxHops: config.maxHops,
      linkThreshold: config.linkThreshold,
      graphWeight: config.graphWeight,
      timeWeight: config.timeWeight,
      directionWeight: config.directionWeight,
      nestedDecay: config.nestedDecay,
      fingerprintLabels: config.fingerprintLabels ?? null,
    },
    stats: {
      ...merged.stats,
      clusterCount: clusters.length,
      suppressedClusterEvidence: clusters.reduce(
        (total, cluster) => total + cluster.suppressionEvidence.length,
        0
      ),
      openClusters: clusters.filter((cluster) => cluster.open).length,
    },
    clusters,
    suppressedAlerts: merged.suppressedAlerts,
    unassignedSuppressedAlerts: merged.suppressedAlerts.filter((alert) =>
      clusters.every((cluster) =>
        !cluster.suppressionEvidence.some((item) => item.alertId === alert.id)
      )
    ),
    evidence: merged.evidence,
  };
}
