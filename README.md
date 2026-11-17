# incident-correlation-engine

纯 Node.js（ESM、零依赖）告警关联引擎。输入服务依赖图与带开始/恢复时间、标签、实例的告警，依次完成
**去重合并 → 抑制 → 时钟修正 → 事件簇聚类 → 根因候选评分**，并为每个事件簇保留可追溯的证据链，
而不是只输出一个无法解释的分数。

## 处理流水线

1. **归一化**：时间统一为毫秒时间戳（支持数字、ISO 字符串、`Date`），按实例/服务时钟偏移修正。
2. **指纹去重与生命周期合并**：同指纹告警合并为一条生命周期，保留全部原始生源。
3. **维护窗口抑制**：命中抑制规则或 `maintenance` 标签的告警不参与聚类，但保留抑制证据。
4. **链路评估**：逐对告警按依赖关系、时间接近度、指标方向打分。
5. **并查集聚类**：达标的链路连接成事件簇。
6. **根因评分**：簇内每个服务都是候选，输出分数分解、传播链与证据。

## 输入格式

```js
import { correlate } from './lib/index.js';

const result = correlate({
  dependencyGraph: {
    services: ['db', 'api', 'web'],
    edges: [
      // direction: 'upstream' 表示 source 依赖 target（target 是 source 的上游）
      { source: 'api', target: 'db', direction: 'upstream' },
      { source: 'web', target: 'api', direction: 'upstream' },
      // direction: 'downstream' 表示 source 是 target 的上游，传播方向 source -> target
    ],
  },
  clockOffsets: { 'db-1': -120000 }, // 可选：真实时间 = 报告时间 + offset，键为实例或服务名
  suppressionRules: [                  // 可选：维护窗口
    { id: 'mw-1', service: 'db', start: '2026-11-17T00:00:00Z', end: '2026-11-17T02:00:00Z',
      reason: 'db 升级', instance: 'db-1', metric: 'cpu', labels: { env: 'prod' } },
  ],
  alerts: [
    {
      id: 'a1',                 // 必填，唯一
      service: 'db',            // 必填
      instance: 'db-1',         // 可选
      metric: 'cpu',            // 可选
      direction: 'spike',       // 可选：spike / drop / none 等任意方向标签
      labels: { env: 'prod' },  // 可选
      start: 1700000000000,      // 必填：数字、ISO 字符串或 Date
      recovery: 1700000300000,   // 可空：null/undefined 表示未恢复
    },
  ],
}, {
  timeWindowMs: 5 * 60 * 1000,  // 可选，以下均为默认值
  maxHops: 3,
  linkThreshold: 0.3,
  graphWeight: 0.6,
  timeWeight: 0.3,
  directionWeight: 0.1,
  nestedDecay: 0.75,
  fingerprintLabels: undefined, // 可选：限定参与指纹的标签键
});
```

## 关联规则

### 1. 指纹去重与生命周期合并

- 指纹 = `service | instance | metric | 排序后的标签键值对`（`fingerprintLabels` 可限定标签键）。
- 同指纹的多条告警合并为一条：`start` 取最早，任一生源未恢复则合并结果保持未闭合，
  `end` 取所有已恢复生源的最大值；全部原始告警保存在 `sources` 中，并产生 `dedup` /
  `open-lifecycle` 证据。
- 不同实例或不同指标的告警指纹不同，不会被错误合并。

### 2. 维护窗口抑制

- 抑制规则按 `service / instance / metric / labels` 匹配，并要求告警开始时间落在窗口内；
  告警标签中带 `maintenance` 键时同样视为受抑制（键名可通过 `suppressLabelKey` 配置）。
- 被抑制的告警从聚类输入中剔除（避免维护噪声刷高告警量、淹没根因），但：
  - 仍出现在结果的 `suppressedAlerts` 中，带命中的规则与原因；
  - 若与某个活跃簇时间接近且拓扑相关，会在该簇的 `suppressionEvidence` 中留痕。
- 窗口外的历史告警不受影响。

### 3. 时钟偏差修正

- `clockOffsets` 按实例名优先、服务名兜底提供偏移，**真实时间 = 报告时间 + offset**。
- 修正同时作用于开始与恢复时间；原始时间 (`startRaw`)、修正后时间和偏移量都保留在生源中，
  簇证据里会产生 `clock-skew` 条目，避免因机器时钟快慢造成的错误时序判断。

### 4. 链路评分（两告警是否关联）

对每对告警先做硬门槛过滤：拓扑必须可达，且开始时间差不超过 `timeWindowMs`。
通过后计算三个因子：

- **图因子（权重 0.6）**：直接上下游 = 1；同服务 = 0.9；传递依赖按
  `nestedDecay ^ 跳数`（默认 `0.75 ^ hops`）衰减，超过 `maxHops` 不关联。
- **时间因子（权重 0.3）**：`1 - 开始时间差 / timeWindowMs`；生命周期重叠时下限为 0.8。
- **方向因子（权重 0.1）**：方向标签相同 = 1，一方无方向 = 0.6，方向相反 = 0.2。

```
linkScore = 0.6 * graphFactor + 0.3 * timeFactor + 0.1 * directionFactor
```

`linkScore >= linkThreshold`（默认 0.3）才建立链路。每条链路都保存关系类型、传播路径、
跳数、时间差、间隔、方向一致性和三个因子的取值（见簇证据中的 `link` 条目）。

### 5. 事件簇

- 使用并查集把被链路连通的告警聚成一个事件簇；无任何链路的告警各自成单元素簇。
- 簇输出按修正后时间排序的 `timeline`、全部 `links`、服务/实例列表、簇起止时间，
  以及方向冲突（`direction-conflict`）、时钟偏差、抑制、未闭合等证据。

### 6. 根因候选评分

簇内**每个服务都是候选**，从五个维度打分（权重之和为 1），并逐项输出 `scoreBreakdown`：

| 维度 | 权重 | 含义 |
| --- | --- | --- |
| 可解释下游面 | 0.45 | 沿依赖图可解释的簇内其他服务占比 |
| 最早起点 | 0.25 | 相对簇起点越早得分越高 |
| 方向一致性 | 0.15 | 与簇内其他告警方向相同多则高，相反则降权 |
| 未恢复 | 0.10 | 告警仍未恢复得满分（故障往往仍在源头持续） |
| 拓扑位置 | 0.05 | 簇内上游依赖越少越像源头 |

每个候选还附带：

- `propagationChain`：从该服务出发到每个可解释服务的 BFS 最短路径、跳数与开始时间差；
- `evidence`：每个维度一条人话证据；
- 并列第一时 `rank` 标记为 `tied-1`，不人为制造唯一答案。

### 7. 双向依赖

两个服务互为上下游（调用环）时，链路关系标记为 `bidirectional`、`ambiguous: true`，
不生成单方向传播路径；相关候选的 `ambiguous` 与 `bidirectionalWith` 同步标记，
提示值班人员需要结合其他证据判断源头。

### 8. 恢复不完整

簇内任一告警 `recovery` 为空时，簇 `open: true`、`end: null`，并产生
`incomplete-recovery` 证据列出未恢复的告警；全部恢复后簇正常闭合。

## 输出结构（摘要）

```
result
├── stats                  # 原始数、合并数、抑制数、簇数、未闭合簇数等
├── clusters[]
│   ├── timeline[]         # 修正后时间线（含 rawStart 与 clockOffset）
│   ├── links[]            # 每条关联链路的三因子评分与传播路径
│   ├── evidence[]         # link / clock-skew / direction-conflict /
│   │                      # suppression / incomplete-recovery 证据
│   ├── suppressionEvidence[]
│   └── rootCandidates[]   # 分数分解 + 传播链 + 分维度证据
├── suppressedAlerts[]     # 被抑制的合并告警及命中规则
└── evidence[]             # 去重/生命周期合并阶段的证据
```

## 测试

```bash
node --test
```

`test/` 覆盖六类场景：级联故障、双向依赖、重复告警、时钟偏差、抑制风、恢复不完整，
另含指标方向冲突、时间窗口外不关联、标签指纹等边界用例。
