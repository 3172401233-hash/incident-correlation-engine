import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlate, DependencyGraph } from '../lib/index.js';

const T = 1_700_000_000_000;
const SECOND = 1_000;

test('双向依赖：两个服务互为上下游时标记歧义，不武断指定唯一根因', () => {
  const input = {
    dependencyGraph: {
      services: ['order', 'inventory'],
      edges: [
        { source: 'order', target: 'inventory', direction: 'upstream' },
        { source: 'inventory', target: 'order', direction: 'upstream' },
      ],
    },
    alerts: [
      { id: 'order-1', service: 'order', instance: 'o-1', metric: 'errors', direction: 'spike', start: T + 10 * SECOND, recovery: T + 300_000 },
      { id: 'inv-1', service: 'inventory', instance: 'i-1', metric: 'errors', direction: 'spike', start: T, recovery: T + 300_000 },
    ],
  };

  const result = correlate(input);
  assert.equal(result.stats.clusterCount, 1);
  const cluster = result.clusters[0];
  const link = cluster.links[0];
  assert.equal(link.relation, 'bidirectional');
  assert.equal(link.ambiguous, true);
  assert.equal(link.propagationPath, null);

  for (const candidate of cluster.rootCandidates) {
    assert.equal(candidate.ambiguous, true);
    assert.ok(candidate.bidirectionalWith.length >= 1);
    assert.ok(candidate.evidence.some((item) =>
      item.type === 'explainer' && item.message.includes('下游传播')
    ));
  }

  // 起点更早的 inventory 仍可排在前面，但歧义必须在输出中可见。
  assert.equal(cluster.rootCandidates[0].service, 'inventory');
});

test('DependencyGraph 正确区分 upstream / downstream / bidirectional / unrelated', () => {
  const graph = new DependencyGraph({
    services: ['a', 'b', 'c'],
    edges: [{ source: 'a', target: 'b', direction: 'upstream' }],
  });
  assert.equal(graph.relation('a', 'b'), 'downstream');
  assert.equal(graph.relation('b', 'a'), 'upstream');
  assert.equal(graph.relation('a', 'c'), 'unrelated');
  assert.equal(graph.isBidirectional('a', 'b'), false);
  assert.deepEqual(graph.shortestPath('b', 'a'), { path: ['b', 'a'], hops: 1 });
  assert.equal(graph.shortestPath('a', 'c'), null);
});
