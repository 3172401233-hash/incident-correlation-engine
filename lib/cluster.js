// 事件簇构建：逐对评估链路（图关系、时间接近度、指标方向），并查集聚类，保留完整证据链。

import { gapBetween, startDelta, describeRelation, formatOffset } from './time.js';

export const DEFAULT_CORRELATION_OPTIONS = {
  timeWindowMs: 5 * 60 * 1000,
  maxHops: 3,
  linkThreshold: 0.3,
  graphWeight: 0.6,
  timeWeight: 0.3,
  directionWeight: 0.1,
  nestedDecay: 0.75,
};

export function directionConsistency(a, b) {
  const da = a.direction ?? 'none';
  const db = b.direction ?? 'none';
  if (da === 'none' || db === 'none') return 'neutral';
  if (da === db) return 'same';
  return 'opposite';
}

function directionFactor(consistency) {
  if (consistency === 'same') return 1;
  if (consistency === 'opposite') return 0.2;
  return 0.6;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index) {
    while (this.parent[index] !== index) {
      this.parent[index] = this.parent[this.parent[index]];
      index = this.parent[index];
    }
    return index;
  }

  union(a, b) {
    this.parent[this.find(a)] = this.find(b);
  }
}

function evaluateLink(a, b, graph, options) {
  const relation = graph.relation(a.service, b.service);
  if (relation === 'unrelated') return null;

  const delta = startDelta(a, b);
  if (delta > options.timeWindowMs) return null;

  let graphFactor;
  let path = null;
  if (relation === 'self') {
    graphFactor = 0.9;
    path = { path: [a.service], hops: 0 };
  } else if (relation === 'bidirectional') {
    graphFactor = 1;
  } else if (relation === 'upstream') {
    path = graph.shortestPath(a.service, b.service);
    graphFactor = path && path.hops === 1 ? 1 : options.nestedDecay ** (path?.hops ?? options.maxHops);
  } else {
    path = graph.shortestPath(b.service, a.service);
    graphFactor = path && path.hops === 1 ? 1 : options.nestedDecay ** (path?.hops ?? options.maxHops);
  }
  if (path && path.hops > options.maxHops) return null;

  const gap = gapBetween(a, b);
  const linear = Math.max(0, 1 - delta / options.timeWindowMs);
  const timeFactor = gap === 0 ? Math.max(0.8, linear) : linear;

  const consistency = directionConsistency(a, b);
  const dirFactor = directionFactor(consistency);

  const score =
    options.graphWeight * graphFactor +
    options.timeWeight * timeFactor +
    options.directionWeight * dirFactor;

  if (score < options.linkThreshold) return null;

  return {
    alertPair: [a.id, b.id],
    services: [a.service, b.service],
    relation,
    propagationPath: path?.path ?? null,
    hops: path?.hops ?? null,
    ambiguous: relation === 'bidirectional',
    timeRelation: describeRelation(a, b),
    startDeltaMs: delta,
    gapMs: gap,
    direction: {
      a: a.direction,
      b: b.direction,
      consistency,
    },
    score: Number(score.toFixed(4)),
    factors: {
      graphFactor: Number(graphFactor.toFixed(4)),
      timeFactor: Number(timeFactor.toFixed(4)),
      directionFactor: dirFactor,
    },
  };
}

function clockSkewEvidence(alerts) {
  const evidence = [];
  for (const alert of alerts) {
    const skewed = alert.sources.filter((source) => source.clockOffset !== 0);
    for (const source of skewed) {
      evidence.push({
        type: 'clock-skew',
        alertId: alert.id,
        rawAlertId: source.id,
        message: `告警 ${source.id} 原始时间 ${source.startRaw} 修正为 ${source.start}（偏移 ${formatOffset(source.clockOffset)}）`,
        clockOffset: source.clockOffset,
        rawStart: source.startRaw,
        correctedStart: source.start,
      });
    }
  }
  return evidence;
}

function attachSuppressed(cluster, suppressedAlerts, graph, options) {
  for (const suppressed of suppressedAlerts) {
    const related = cluster.alerts.some((alert) => {
      const relation = graph.relation(alert.service, suppressed.service);
      return relation !== 'unrelated' &&
        Math.abs(alert.start - suppressed.start) <= options.timeWindowMs;
    });
    if (!related) continue;
    cluster.suppressionEvidence.push({
      type: 'suppression',
      message: `告警 ${suppressed.id} 命中维护窗口抑制，不参与关联：${suppressed.suppressedBy.map((item) => item.reason).join('; ')}`,
      alertId: suppressed.id,
      fingerprint: suppressed.fingerprint,
      rules: suppressed.suppressedBy,
    });
  }
}

export function buildClusters(mergedResult, graph, options = {}) {
  const config = { ...DEFAULT_CORRELATION_OPTIONS, ...options };
  const alerts = mergedResult.alerts;
  const uf = new UnionFind(alerts.length);
  const links = [];

  for (let i = 0; i < alerts.length; i += 1) {
    for (let j = i + 1; j < alerts.length; j += 1) {
      const link = evaluateLink(alerts[i], alerts[j], graph, config);
      if (link) {
        links.push(link);
        uf.union(i, j);
      }
    }
  }

  const components = new Map();
  alerts.forEach((alert, index) => {
    const root = uf.find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(alert);
  });

  const clusters = [];
  let sequence = 0;
  for (const members of components.values()) {
    sequence += 1;
    const ordered = [...members].sort((a, b) => a.start - b.start);
    const ids = new Set(ordered.map((alert) => alert.id));
    const clusterLinks = links.filter(
      (link) => ids.has(link.alertPair[0]) && ids.has(link.alertPair[1])
    );
    const directionConflicts = clusterLinks.filter(
      (link) => link.direction.consistency === 'opposite'
    );
    const open = ordered.some((alert) => alert.end === null);
    const cluster = {
      id: `cluster-${sequence}`,
      alertIds: ordered.map((alert) => alert.id),
      services: [...new Set(ordered.map((alert) => alert.service))],
      instances: [...new Set(ordered.map((alert) => alert.instance).filter(Boolean))],
      start: Math.min(...ordered.map((alert) => alert.start)),
      end: open ? null : Math.max(...ordered.map((alert) => alert.end)),
      open,
      alerts: ordered,
      links: clusterLinks,
      timeline: ordered.map((alert) => ({
        alertId: alert.id,
        service: alert.service,
        instance: alert.instance,
        start: alert.start,
        end: alert.end,
        rawStart: alert.sources[0].startRaw,
        clockOffset: alert.sources[0].clockOffset,
        direction: alert.direction,
      })),
      directionConflicts,
      suppressionEvidence: [],
      evidence: [],
      rootCandidates: [],
    };

    cluster.evidence.push(
      ...clusterLinks.map((link) => ({
        type: 'link',
        message: `${link.services[0]} ↔ ${link.services[1]} 关系=${link.relation}，时间差=${link.startDeltaMs}ms，方向=${link.direction.consistency}，链路分=${link.score}`,
        link,
      }))
    );
    cluster.evidence.push(...clockSkewEvidence(ordered));
    for (const conflict of directionConflicts) {
      cluster.evidence.push({
        type: 'direction-conflict',
        message: `${conflict.services[0]}(${conflict.direction.a}) 与 ${conflict.services[1]}(${conflict.direction.b}) 指标方向相反，传播解释力下降`,
        link: conflict,
      });
    }
    attachSuppressed(cluster, mergedResult.suppressedAlerts, graph, config);
    cluster.evidence.push(...cluster.suppressionEvidence);
    if (open) {
      cluster.evidence.push({
        type: 'incomplete-recovery',
        message: '簇内存在未恢复告警，生命周期未闭合',
        openAlertIds: ordered.filter((alert) => alert.end === null).map((alert) => alert.id),
      });
    }
    clusters.push(cluster);
  }

  clusters.sort((a, b) => a.start - b.start);
  clusters.forEach((cluster, index) => {
    cluster.id = `cluster-${index + 1}`;
  });
  return clusters;
}
