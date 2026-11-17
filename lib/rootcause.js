// 根因候选：基于可解释的下游传播面、最早起点、指标方向一致性和未恢复状态打分。
// 每个候选输出分数分解与证据，不输出无法解释的单一分数。

import { directionConsistency } from './cluster.js';

const WEIGHTS = {
  explainer: 0.45,
  earliest: 0.25,
  direction: 0.15,
  open: 0.1,
  upstream: 0.05,
};

function buildPropagation(service, cluster, graph) {
  const hops = [];
  const paths = [];
  const otherServices = cluster.services.filter((item) => item !== service);
  for (const target of otherServices) {
    const path = graph.shortestPath(service, target);
    if (!path) continue;
    paths.push(path);
    const targetAlert = cluster.alerts.find((alert) => alert.service === target);
    const sourceAlert = cluster.alerts.find((alert) => alert.service === service);
    hops.push({
      from: service,
      to: target,
      path: path.path,
      hops: path.hops,
      startDeltaMs: targetAlert && sourceAlert ? targetAlert.start - sourceAlert.start : null,
      direction: sourceAlert && targetAlert
        ? directionConsistency(sourceAlert, targetAlert)
        : 'neutral',
    });
  }
  hops.sort((a, b) => a.hops - b.hops || a.startDeltaMs - b.startDeltaMs);
  return hops;
}

function findAlert(service, cluster) {
  return cluster.alerts
    .filter((alert) => alert.service === service)
    .sort((a, b) => a.start - b.start)[0];
}

export function rankRootCandidates(cluster, graph) {
  const { services } = cluster;
  const clusterStart = cluster.start;
  const span = Math.max(
    1,
    ...cluster.alerts.map((alert) => alert.start - clusterStart)
  );

  const candidates = services.map((service) => {
    const alert = findAlert(service, cluster);
    const propagation = buildPropagation(service, cluster, graph);
    const explainedServices = new Set(propagation.map((hop) => hop.to));
    const bidirectionalHits = propagation.filter((hop) =>
      graph.isBidirectional(hop.from, hop.to)
    );

    const explainerScore = services.length <= 1
      ? 1
      : explainedServices.size / (services.length - 1);
    const earliestScore = 1 - (alert.start - clusterStart) / span;

    const conflictCount = cluster.directionConflicts.filter(
      (link) => link.alertPair.includes(alert.id)
    ).length;
    const consistencyChecks = cluster.alerts
      .filter((other) => other.id !== alert.id)
      .map((other) => directionConsistency(alert, other));
    const sameCount = consistencyChecks.filter((value) => value === 'same').length;
    const oppositeCount = consistencyChecks.filter((value) => value === 'opposite').length;
    const directionScore = consistencyChecks.length === 0
      ? 0.6
      : (sameCount * 1 + oppositeCount * 0.2 +
        (consistencyChecks.length - sameCount - oppositeCount) * 0.6) /
        consistencyChecks.length;

    const openScore = alert.end === null ? 1 : 0;
    const upstreamCount = graph.upstream.get(service)?.filter((item) =>
      cluster.services.includes(item)
    ).length ?? 0;
    const upstreamScore = services.length <= 1 ? 0 : upstreamCount / (services.length - 1);

    const score =
      WEIGHTS.explainer * explainerScore +
      WEIGHTS.earliest * earliestScore +
      WEIGHTS.direction * directionScore +
      WEIGHTS.open * openScore +
      WEIGHTS.upstream * (1 - upstreamScore);

    const evidence = [
      {
        type: 'explainer',
        message: `可解释 ${explainedServices.size}/${services.length - 1} 个其他服务的下游传播`,
        explainedServices: [...explainedServices],
      },
      {
        type: 'earliest',
        message: `告警开始于 ${alert.start}，距簇起点 ${alert.start - clusterStart}ms`,
        start: alert.start,
        offsetFromClusterStartMs: alert.start - clusterStart,
      },
      {
        type: 'direction',
        message: `方向一致 ${sameCount} 条、相反 ${oppositeCount} 条，冲突链路 ${conflictCount} 条`,
        sameCount,
        oppositeCount,
        conflictCount,
      },
      {
        type: 'recovery',
        message: alert.end === null ? '该服务告警仍未恢复' : '该服务告警已恢复',
        open: alert.end === null,
      },
      {
        type: 'topology',
        message: `簇内上游依赖 ${upstreamCount} 个，上游越少越可能是源头`,
        upstreamCount,
      },
    ];

    return {
      service,
      alertId: alert.id,
      score: Number(score.toFixed(4)),
      scoreBreakdown: {
        explainer: Number((WEIGHTS.explainer * explainerScore).toFixed(4)),
        earliest: Number((WEIGHTS.earliest * earliestScore).toFixed(4)),
        direction: Number((WEIGHTS.direction * directionScore).toFixed(4)),
        open: Number((WEIGHTS.open * openScore).toFixed(4)),
        topology: Number((WEIGHTS.upstream * (1 - upstreamScore)).toFixed(4)),
      },
      ambiguous: bidirectionalHits.length > 0,
      bidirectionalWith: [...new Set(bidirectionalHits.map((hop) => hop.to))],
      propagationChain: propagation,
      evidence,
    };
  });

  candidates.sort((a, b) =>
    b.score - a.score ||
    a.alertId.localeCompare(b.alertId)
  );

  const best = candidates[0]?.score ?? 0;
  const tiedCount = candidates.filter((candidate) =>
    Math.abs(candidate.score - best) < 1e-4
  ).length;
  candidates.forEach((candidate, index) => {
    candidate.rank = index < tiedCount && tiedCount > 1
      ? 'tied-1'
      : String(index + 1);
  });
  return candidates;
}
