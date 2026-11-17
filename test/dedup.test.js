import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate, fingerprint } from '../lib/index.js';

const T = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

test('重复告警：同指纹事件合并为一条生命周期并保留全部生源', () => {
  const input = {
    dependencyGraph: {
      services: ['db', 'api'],
      edges: [{ source: 'api', target: 'db', direction: 'upstream' }],
    },
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', labels: { env: 'prod', team: 'data' }, start: T, recovery: T + 8 * MINUTE },
      { id: 'db-2', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', labels: { env: 'prod', team: 'data' }, start: T + 40 * SECOND, recovery: T + 8 * MINUTE },
      { id: 'db-3', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', labels: { env: 'prod', team: 'data' }, start: T + 90 * SECOND, recovery: T + 9 * MINUTE },
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T + 45 * SECOND, recovery: T + 10 * MINUTE },
    ],
  };

  const result = correlate(input);
  assert.equal(result.stats.rawCount, 4);
  assert.equal(result.stats.mergedCount, 2);
  assert.equal(result.stats.duplicateCollapsed, 2);

  const cluster = result.clusters[0];
  const dbAlert = cluster.alerts.find((alert) => alert.service === 'db');
  assert.equal(dbAlert.duplicateCount, 3);
  assert.deepEqual(dbAlert.sources.map((source) => source.id), ['db-1', 'db-2', 'db-3']);
  assert.equal(dbAlert.start, T);
  assert.equal(dbAlert.end, T + 9 * MINUTE);

  const dedupEvidence = result.evidence.filter((item) => item.type === 'dedup');
  assert.equal(dedupEvidence.length, 1);
  assert.deepEqual(dedupEvidence[0].rawAlertIds, ['db-1', 'db-2', 'db-3']);
  assert.equal(dedupEvidence[0].startSpreadMs, 90 * SECOND);
});

test('同服务不同实例或指标不会被错误去重', () => {
  const fp1 = fingerprint({ service: 'db', instance: 'db-1', metric: 'cpu', labels: {} });
  const fp2 = fingerprint({ service: 'db', instance: 'db-2', metric: 'cpu', labels: {} });
  const fp3 = fingerprint({ service: 'db', instance: 'db-1', metric: 'disk', labels: {} });
  assert.notEqual(fp1, fp2);
  assert.notEqual(fp1, fp3);
});

test('fingerprintLabels 限定参与指纹的标签键', () => {
  const a = { service: 'db', instance: 'i', metric: 'cpu', labels: { env: 'prod', shard: '1' } };
  const b = { service: 'db', instance: 'i', metric: 'cpu', labels: { env: 'prod', shard: '2' } };
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a, ['env']), fingerprint(b, ['env']));
});

test('部分重复生源未恢复时，合并后的生命周期保持未闭合', () => {
  const input = {
    dependencyGraph: { services: ['db'], edges: [] },
    alerts: [
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T, recovery: T + 5 * MINUTE },
      { id: 'db-2', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T + 30 * SECOND, recovery: null },
    ],
  };
  const result = correlate(input);
  const alert = result.clusters[0].alerts[0];
  assert.equal(alert.end, null);
  assert.ok(result.evidence.some((item) => item.type === 'open-lifecycle'));
});
