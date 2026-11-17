// 归一化 -> 指纹去重 -> 生命周期合并 -> 维护窗口抑制。

import { normalizeAlert, toMillis, isOpen } from './time.js';

function stableLabelString(labels, fingerprintLabels) {
  const keys = fingerprintLabels
    ? fingerprintLabels.filter((key) => labels[key] !== undefined)
    : Object.keys(labels).sort();
  return keys.map((key) => `${key}=${labels[key]}`).join(',');
}

export function fingerprint(alert, fingerprintLabels) {
  const instancePart = alert.instance ?? '_';
  const metricPart = alert.metric ?? '_';
  const labelPart = stableLabelString(alert.labels ?? {}, fingerprintLabels);
  return `${alert.service}|${instancePart}|${metricPart}|{${labelPart}}`;
}

function labelsMatch(ruleLabels, alertLabels) {
  if (!ruleLabels) return true;
  return Object.entries(ruleLabels).every(([key, value]) => alertLabels?.[key] === value);
}

export function ruleMatches(rule, alert) {
  if (rule.service !== undefined && rule.service !== alert.service) return false;
  if (rule.instance !== undefined && rule.instance !== alert.instance) return false;
  if (rule.metric !== undefined && rule.metric !== alert.metric) return false;
  return labelsMatch(rule.labels, alert.labels);
}

function withinWindow(rule, timeMs) {
  const windowStart = toMillis(rule.start);
  const windowEnd = rule.end === null || rule.end === undefined ? null : toMillis(rule.end);
  if (timeMs < windowStart) return false;
  if (windowEnd !== null && timeMs > windowEnd) return false;
  return true;
}

function findSuppression(rule, alert) {
  if (!ruleMatches(rule, alert)) return null;
  // 合并后的告警任一生源落在窗口内即视为受抑制，并记录具体命中的生源。
  const hits = alert.sources.filter((source) => withinWindow(rule, source.start));
  if (hits.length === 0) return null;
  return {
    ruleId: rule.id ?? null,
    reason: rule.reason ?? 'maintenance-window',
    window: {
      start: toMillis(rule.start),
      end: rule.end === null || rule.end === undefined ? null : toMillis(rule.end),
    },
    hitSourceIds: hits.map((source) => source.id),
  };
}

function buildMerged(fp, members) {
  const ordered = [...members].sort((a, b) => a.start - b.start);
  const first = ordered[0];
  const anyOpen = ordered.some((alert) => isOpen(alert));
  const end = anyOpen ? null : Math.max(...ordered.map((alert) => alert.end));
  return {
    id: first.id,
    fingerprint: fp,
    service: first.service,
    instance: first.instance,
    metric: first.metric,
    direction: first.direction,
    labels: { ...first.labels },
    start: Math.min(...ordered.map((alert) => alert.start)),
    end,
    sources: ordered.map((alert) => ({
      id: alert.id,
      start: alert.start,
      end: alert.end,
      startRaw: alert.startRaw,
      endRaw: alert.endRaw,
      clockOffset: alert.clockOffset,
      direction: alert.direction,
      labels: alert.labels,
    })),
    duplicateCount: ordered.length,
    suppressed: false,
    suppressedBy: [],
  };
}

function mergeEvidence(merged) {
  if (merged.sources.length === 1) return [];
  const starts = merged.sources.map((source) => source.start);
  const evidence = [{
    type: 'dedup',
    message: `指纹 ${merged.fingerprint} 命中 ${merged.sources.length} 条重复告警，合并为一条生命周期`,
    rawAlertIds: merged.sources.map((source) => source.id),
    startSpreadMs: Math.max(...starts) - Math.min(...starts),
  }];
  if (merged.end === null) {
    evidence.push({
      type: 'open-lifecycle',
      message: '重复生源中存在未恢复告警，合并后生命周期保持未闭合',
      rawAlertIds: merged.sources.filter((source) => source.end === null).map((source) => source.id),
    });
  }
  return evidence;
}

export function dedupeAndMerge(rawAlerts, options = {}) {
  const {
    offsets = {},
    fingerprintLabels,
    suppressionRules = [],
    suppressLabelKey = 'maintenance',
  } = options;

  const normalized = rawAlerts.map((alert) => normalizeAlert(alert, offsets));
  const groups = new Map();
  for (const alert of normalized) {
    const fp = fingerprint(alert, fingerprintLabels);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(alert);
  }

  const mergedAlerts = [];
  const evidence = [];
  for (const [fp, members] of groups) {
    const merged = buildMerged(fp, members);
    const dedupEvidence = mergeEvidence(merged);
    if (dedupEvidence.length > 0) evidence.push(...dedupEvidence);

    for (const rule of suppressionRules) {
      const hit = findSuppression(rule, merged);
      if (hit) merged.suppressedBy.push(hit);
    }
    for (const source of merged.sources) {
      if (source.labels?.[suppressLabelKey]) {
        merged.suppressedBy.push({
          ruleId: null,
          reason: `label:${suppressLabelKey}=${source.labels[suppressLabelKey]}`,
          window: { start: source.start, end: source.end },
          hitSourceIds: [source.id],
        });
      }
    }
    merged.suppressed = merged.suppressedBy.length > 0;
    mergedAlerts.push(merged);
  }

  mergedAlerts.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const active = mergedAlerts.filter((alert) => !alert.suppressed);
  const suppressed = mergedAlerts.filter((alert) => alert.suppressed);

  return {
    alerts: active,
    suppressedAlerts: suppressed,
    allAlerts: mergedAlerts,
    evidence,
    stats: {
      rawCount: rawAlerts.length,
      mergedCount: mergedAlerts.length,
      suppressedCount: suppressed.length,
      duplicateCollapsed: rawAlerts.length - mergedAlerts.length,
    },
  };
}
