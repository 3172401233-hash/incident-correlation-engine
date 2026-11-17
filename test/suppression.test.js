import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate } from '../lib/index.js';

const T = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const baseGraph = {
  services: ['db', 'api', 'web', 'batch'],
  edges: [
    { source: 'api', target: 'db', direction: 'upstream' },
    { source: 'web', target: 'api', direction: 'upstream' },
  ],
};

test('维护窗口规则：窗口内告警被抑制并从簇中剔除，但保留抑制证据', () => {
  const input = {
    dependencyGraph: baseGraph,
    suppressionRules: [
      {
        id: 'mw-db',
        service: 'db',
        start: T - MINUTE,
        end: T + 20 * MINUTE,
        reason: 'db 升级维护',
      },
    ],
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T + 20 * SECOND, recovery: T + 5 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 40 * SECOND, recovery: T + 9 * MINUTE },
      { id: 'web-1', service: 'web', instance: 'web-1', metric: 'latency', direction: 'spike', start: T + 70 * SECOND, recovery: T + 10 * MINUTE },
    ],
  };

  const result = correlate(input);
  assert.equal(result.stats.suppressedCount, 1);
  assert.equal(result.suppressedAlerts[0].id, 'db-1');
  assert.equal(result.suppressedAlerts[0].suppressedBy[0].ruleId, 'mw-db');

  // 抑制不参与聚类：api/web 仍成簇，db 不在任何活跃簇内。
  assert.equal(result.stats.clusterCount, 1);
  const cluster = result.clusters[0];
  assert.deepEqual(cluster.services, ['api', 'web']);

  const suppressionEvidence = cluster.suppressionEvidence;
  assert.equal(suppressionEvidence.length, 1);
  assert.equal(suppressionEvidence[0].alertId, 'db-1');
  assert.ok(suppressionEvidence[0].message.includes('db 升级维护'));
  assert.equal(result.stats.suppressedClusterEvidence, 1);
});

test('抑制风：维护窗口内几十条重复/相关告警全部被压制，根因不被噪声淹没', () => {
  const alerts = [];
  for (let i = 0; i < 20; i += 1) {
    alerts.push({
      id: `db-noise-${i}`,
      service: 'db',
      instance: `db-${i % 3}`,
      metric: 'replication_lag',
      direction: 'spike',
      labels: { maintenance: 'db-rollout' },
      start: T + i * 5 * SECOND,
      recovery: T + 10 * MINUTE,
    });
  }
  alerts.push(
    { id: 'web-1', service: 'web', instance: 'web-1', metric: 'latency', direction: 'spike', start: T + 15 * SECOND, recovery: T + 8 * MINUTE },
    { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 10 * SECOND, recovery: T + 8 * MINUTE }
  );

  const result = correlate({ dependencyGraph: baseGraph, alerts });
  assert.equal(result.stats.rawCount, 22);
  // 3 个 db 实例各成一条指纹，全部因 maintenance 标签被抑制。
  assert.equal(result.stats.suppressedCount, 3);
  assert.deepEqual([...result.clusters[0].alertIds].sort(), ['api-1', 'web-1']);
  for (const suppressed of result.suppressedAlerts) {
    assert.ok(suppressed.suppressedBy.some((item) => item.reason.includes('maintenance')));
  }
});

test('窗口外的历史告警不受抑制规则影响', () => {
  const input = {
    dependencyGraph: baseGraph,
    suppressionRules: [
      { id: 'future-mw', service: 'db', start: T + 30 * MINUTE, end: T + 60 * MINUTE },
    ],
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T, recovery: T + 5 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 30 * SECOND, recovery: T + 6 * MINUTE },
    ],
  };
  const result = correlate(input);
  assert.equal(result.stats.suppressedCount, 0);
  assert.equal(result.stats.clusterCount, 1);
});
