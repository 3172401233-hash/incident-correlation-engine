// 服务依赖图：direction "upstream" 表示 source 依赖 target（target 是 source 的上游）。
// 根因沿下游方向传播：上游故障 -> 下游报错。

export class DependencyGraph {
  constructor(graph = {}) {
    this.nodes = new Set(graph.services ?? []);
    this.downstream = new Map();
    this.upstream = new Map();
    this.edges = [];
    for (const service of this.nodes) {
      this.downstream.set(service, []);
      this.upstream.set(service, []);
    }
    for (const edge of graph.edges ?? []) {
      this.addEdge(edge);
    }
  }

  addNode(service) {
    if (!this.nodes.has(service)) {
      this.nodes.add(service);
      this.downstream.set(service, []);
      this.upstream.set(service, []);
    }
  }

  addEdge(edge) {
    // upstream: source 依赖 target，传播方向 target -> source。
    // downstream: source 是 target 的上游，传播方向 source -> target。
    const from = edge.direction === 'downstream' ? edge.source : edge.target;
    const to = edge.direction === 'downstream' ? edge.target : edge.source;
    this.addNode(from);
    this.addNode(to);

    const record = { from, to, raw: edge };
    this.edges.push(record);
    this.downstream.get(record.from).push(record.to);
    this.upstream.get(record.to).push(record.from);
    return record;
  }

  has(service) {
    return this.nodes.has(service);
  }

  // 双向依赖：两个服务互为上下游（调用环）。
  isBidirectional(a, b) {
    return (
      this.downstream.get(a)?.includes(b) &&
      this.downstream.get(b)?.includes(a)
    );
  }

  // 返回 a 相对 b 的依赖关系：upstream/downstream/bidirectional/unrelated/self。
  relation(a, b) {
    if (a === b) return 'self';
    const aDown = this.downstream.get(a)?.includes(b) ?? false;
    const bDown = this.downstream.get(b)?.includes(a) ?? false;
    if (aDown && bDown) return 'bidirectional';
    if (aDown) return 'upstream'; // a 在 b 上游
    if (bDown) return 'downstream';
    return 'unrelated';
  }

  // BFS 最短传播路径，返回 { path, hops }，不可达返回 null。
  shortestPath(from, to) {
    if (from === to) return { path: [from], hops: 0 };
    const queue = [from];
    const prev = new Map([[from, null]]);
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of this.downstream.get(current) ?? []) {
        if (prev.has(next)) continue;
        prev.set(next, current);
        if (next === to) {
          const path = [];
          let cursor = to;
          while (cursor !== null) {
            path.unshift(cursor);
            cursor = prev.get(cursor);
          }
          return { path, hops: path.length - 1 };
        }
        queue.push(next);
      }
    }
    return null;
  }

  // 统计簇内可解释的下游传播边（from 已在簇内、to 也在簇内）。
  downstreamPairs(services) {
    const set = new Set(services);
    const pairs = [];
    for (const [from, tos] of this.downstream) {
      if (!set.has(from)) continue;
      for (const to of tos) {
        if (set.has(to)) pairs.push({ from, to });
      }
    }
    return pairs;
  }
}
