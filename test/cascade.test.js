import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate } from '../lib/index.js';

const T = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const dependencyGraph = {
  services: ['db', 'api', 'web', 'billing'],
  edges: [
    { source: 'api', target: 'db', direction: 'upstream' },
    { source: 'web', target: 'api', direction: 'upstream' },
  ],
};

test('级联故障：沿 db -> api -> web 聚成一个簇，db 为根因候选第一名', () => {
  const input = {
    dependencyGraph,
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'connections', direction: 'spike', start: T, recovery: T + 10 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 30 * SECOND, recovery: T + 11 * MINUTE },
      { id: 'web-1', service: 'web', instance: 'web-1', metric: 'latency', direction: 'spike', start: T + 60 * SECOND, recovery: T + 12 * MINUTE },
      { id: 'bill-1', service: 'billing', instance: 'bill-1', metric: 'queue', direction: 'spike', start: T + 45 * SECOND, recovery: T + 5 * MINUTE },
    ],
  };

  const result = correlate(input);
  assert.equal(result.stats.clusterCount, 2);

  const main = result.clusters.find((cluster) => cluster.services.includes('db'));
  assert.deepEqual(main.alertIds, ['db-1', 'api-1', 'web-1']);
  assert.equal(main.links.length, 2);
  assert.ok(main.links.every((link) => link.relation === 'upstream'));

  const dbApi = main.links.find((link) => link.alertPair.includes('db-1') && link.alertPair.includes('api-1'));
  assert.deepEqual(dbApi.propagationPath, ['db', 'api']);
  assert.equal(dbApi.direction.consistency, 'same');
  assert.ok(dbApi.score >= 0.9);

  const root = main.rootCandidates[0];
  assert.equal(root.service, 'db');
  assert.equal(root.rank, '1');
  const chain = root.propagationChain.map((hop) => `${hop.from}->${hop.to}`);
  assert.deepEqual(chain, ['db->api', 'db->web']);
  assert.deepEqual(root.propagationChain[1].path, ['db', 'api', 'web']);

  // 每个候选必须带分数分解和证据，而不是单个黑盒分数。
  for (const candidate of main.rootCandidates) {
    assert.ok(candidate.score > 0);
    assert.ok(Object.keys(candidate.scoreBreakdown).length >= 5);
    const breakdownSum = Object.values(candidate.scoreBreakdown)
      .reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(breakdownSum - candidate.score) < 0.01);
    assert.ok(candidate.evidence.length >= 4);
  }

  // 簇级证据链包含每条链路的解释。
  const linkEvidence = main.evidence.filter((item) => item.type === 'link');
  assert.equal(linkEvidence.length, 2);
  assert.ok(linkEvidence.every((item) => item.message.includes('链路分=')));
});

test('时间窗口外的关联服务告警不会被强行并入同一簇', () => {
  const input = {
    dependencyGraph,
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'connections', direction: 'spike', start: T, recovery: T + 10 * MINUTE },
      { id: 'api-late', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 6 * MINUTE, recovery: T + 12 * MINUTE },
    ],
  };
  const result = correlate(input);
  assert.equal(result.stats.clusterCount, 2);
});

test('指标方向相反时仍可同簇，但记录方向冲突并降低解释力', () => {
  const input = {
    dependencyGraph,
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'connections', direction: 'spike', start: T, recovery: T + 10 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'success_rate', direction: 'drop', start: T + 20 * SECOND, recovery: T + 10 * MINUTE },
    ],
  };
  const result = correlate(input);
  const cluster = result.clusters[0];
  assert.equal(cluster.alerts.length, 2);
  assert.equal(cluster.directionConflicts.length, 1);
  assert.equal(cluster.directionConflicts[0].direction.consistency, 'opposite');
  assert.ok(cluster.evidence.some((item) => item.type === 'direction-conflict'));

  const conflictLink = cluster.links[0];
  assert.equal(conflictLink.factors.directionFactor, 0.2);
  const root = cluster.rootCandidates.find((candidate) => candidate.service === 'db');
  const directionEvidence = root.evidence.find((item) => item.type === 'direction');
  assert.equal(directionEvidence.oppositeCount, 1);
});
