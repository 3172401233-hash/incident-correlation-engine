import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate } from '../lib/index.js';

const T = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const graph = {
  services: ['db', 'api', 'web'],
  edges: [
    { source: 'api', target: 'db', direction: 'upstream' },
    { source: 'web', target: 'api', direction: 'upstream' },
  ],
};

test('恢复不完整：下游未恢复时簇保持开放并记录未闭合证据', () => {
  const input = {
    dependencyGraph: graph,
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T, recovery: T + 5 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 30 * SECOND, recovery: T + 7 * MINUTE },
      { id: 'web-1', service: 'web', instance: 'web-1', metric: 'latency', direction: 'spike', start: T + 60 * SECOND, recovery: null },
    ],
  };

  const result = correlate(input);
  const cluster = result.clusters[0];
  assert.equal(cluster.open, true);
  assert.equal(cluster.end, null);
  assert.equal(result.stats.openClusters, 1);

  const evidence = cluster.evidence.find((item) => item.type === 'incomplete-recovery');
  assert.deepEqual(evidence.openAlertIds, ['web-1']);

  const webCandidate = cluster.rootCandidates.find((item) => item.service === 'web');
  assert.equal(webCandidate.scoreBreakdown.open, 0.1);
  const dbCandidate = cluster.rootCandidates.find((item) => item.service === 'db');
  assert.equal(dbCandidate.scoreBreakdown.open, 0);
});

test('全部恢复后簇正常闭合，且根因仍为最早的上游', () => {
  const input = {
    dependencyGraph: graph,
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T, recovery: T + 5 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 30 * SECOND, recovery: T + 7 * MINUTE },
      { id: 'web-1', service: 'web', instance: 'web-1', metric: 'latency', direction: 'spike', start: T + 60 * SECOND, recovery: T + 8 * MINUTE },
    ],
  };
  const result = correlate(input);
  const cluster = result.clusters[0];
  assert.equal(cluster.open, false);
  assert.equal(cluster.end, T + 8 * MINUTE);
  assert.equal(result.stats.openClusters, 0);
  assert.ok(!cluster.evidence.some((item) => item.type === 'incomplete-recovery'));
  assert.equal(cluster.rootCandidates[0].service, 'db');
});

test('恢复顺序早于开始时间的异常数据不会产生负间隔', () => {
  const input = {
    dependencyGraph: graph,
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T + 2 * MINUTE, recovery: T + MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 3 * MINUTE, recovery: T + 4 * MINUTE },
    ],
  };
  const result = correlate(input);
  const link = result.clusters[0].links[0];
  assert.ok(link.gapMs >= 0);
  assert.ok(link.startDeltaMs >= 0);
});
