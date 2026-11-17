// 时间处理工具：统一毫秒时间戳、时钟偏差修正、时间接近度判定。

export function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`无法解析的时间值: ${String(value)}`);
  }
  return parsed;
}

// 每个实例/服务的时钟偏移（毫秒）：真实时间 = 报告时间 + offset。
// offsets 同时支持 instance 维度和 service 维度的键。
export function lookupOffset(offsets, alert) {
  if (!offsets) return 0;
  if (alert.instance && offsets[alert.instance] !== undefined) {
    return Number(offsets[alert.instance]) || 0;
  }
  if (alert.service && offsets[alert.service] !== undefined) {
    return Number(offsets[alert.service]) || 0;
  }
  return 0;
}

// 将单条告警的开始/恢复时间修正为真实时间线。
export function normalizeAlert(alert, offsets = {}) {
  const offset = lookupOffset(offsets, alert);
  const startRaw = toMillis(alert.start);
  const endRaw = alert.recovery === null || alert.recovery === undefined
    ? null
    : toMillis(alert.recovery);
  return {
    id: alert.id,
    service: alert.service,
    instance: alert.instance ?? null,
    metric: alert.metric ?? null,
    labels: alert.labels ?? {},
    direction: alert.direction ?? 'none',
    startRaw,
    endRaw,
    clockOffset: offset,
    start: startRaw + offset,
    end: endRaw === null ? null : endRaw + offset,
  };
}

export function isOpen(alert) {
  return alert.end === null || alert.end === undefined;
}

// 两条告警生命周期之间的间隔（毫秒）。重叠返回 0。
export function gapBetween(a, b) {
  const aEnd = isOpen(a) ? Infinity : a.end;
  const bEnd = isOpen(b) ? Infinity : b.end;
  const gap = Math.max(a.start, b.start) - Math.min(aEnd, bEnd);
  return gap > 0 ? gap : 0;
}

export function startDelta(a, b) {
  return Math.abs(a.start - b.start);
}

export function describeRelation(a, b) {
  const overlap = gapBetween(a, b) === 0;
  if (overlap) return 'overlap';
  return a.start <= b.start ? 'before' : 'after';
}

export function formatOffset(offset) {
  if (offset === 0) return '0ms';
  const sign = offset > 0 ? '+' : '-';
  return `${sign}${Math.abs(offset)}ms`;
}
