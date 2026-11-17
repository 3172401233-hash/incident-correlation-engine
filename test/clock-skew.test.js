import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate, normalizeAlert } from '../lib/index.js';

const T = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

test('时钟偏差：按实例偏移修正时间后仍能识别真实级联顺序', () => {
  // db 机器时钟慢 2 分钟：报告的开始时间比真实时间晚，真实时间 = 报告时间 - 120s。
  const input = {
    dependencyGraph: {
      services: ['db', 'api'],
      edges: [{ source: 'api', target: 'db', direction: 'upstream' }],
    },
    clockOffsets: { 'db-1': -2 * MINUTE },
    alerts: [
      // 原始时间上 api 看起来更早；修正后 db 真实开始时间为 T - 30s。
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T, recovery: T + 8 * MINUTE },
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T + 90 * SECOND, recovery: T + 9 * MINUTE },
    ],
  };

  const result = correlate(input);
  assert.equal(result.stats.clusterCount, 1);
  const cluster = result.clusters[0];

  const dbAlert = cluster.alerts.find((alert) => alert.service === 'db');
  assert.equal(dbAlert.sources[0].startRaw, T + 90 * SECOND);
  assert.equal(dbAlert.sources[0].clockOffset, -2 * MINUTE);
  assert.equal(dbAlert.start, T - 30 * SECOND);

  // 修正后 db 在时间线上排第一。
  assert.deepEqual(cluster.timeline.map((item) => item.service), ['db', 'api']);

  const skewEvidence = cluster.evidence.filter((item) => item.type === 'clock-skew');
  assert.equal(skewEvidence.length, 1);
  assert.equal(skewEvidence[0].alertId, 'db-1');
  assert.equal(skewEvidence[0].clockOffset, -2 * MINUTE);

  assert.equal(cluster.rootCandidates[0].service, 'db');
});

test('未修正偏差且超出时间窗口时不会产生虚假关联', () => {
  const input = {
    dependencyGraph: {
      services: ['db', 'api'],
      edges: [{ source: 'api', target: 'db', direction: 'upstream' }],
    },
    alerts: [
      { id: 'api-1', service: 'api', instance: 'api-1', metric: 'errors', direction: 'spike', start: T, recovery: T + 8 * MINUTE },
      { id: 'db-1', service: 'db', instance: 'db-1', metric: 'cpu', direction: 'spike', start: T + 6 * MINUTE, recovery: T + 9 * MINUTE },
    ],
  };
  const result = correlate(input);
  assert.equal(result.stats.clusterCount, 2);
});

test('normalizeAlert 同时支持实例级和服务级偏移', () => {
  const alert = { id: 'x', service: 'svc', instance: 'pod-1', start: T, recovery: T + SECOND };
  assert.equal(normalizeAlert(alert, { 'pod-1': -5_000 }).start, T - 5_000);
  assert.equal(normalizeAlert(alert, { svc: 3_000 }).start, T + 3_000);
  assert.equal(normalizeAlert(alert, { 'pod-1': -5_000, svc: 3_000 }).start, T - 5_000);
});
