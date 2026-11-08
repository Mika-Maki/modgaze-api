// Live, process-local request metrics. Nothing here is written to disk and no
// credential material is ever stored: only group id, protocol, model id, status,
// latency and whether the caller used a virtual key or a passthrough key.
export function createMetrics({ recentLimit = 200, bucketMs = 60000, bucketCount = 60 } = {}) {
  let startedAt = Date.now();
  let requests = 0;
  let errors = 0;
  let latencySum = 0;
  let latencyMax = 0;
  const statuses = new Map();
  const protocols = new Map();
  const groups = new Map();
  const authKinds = new Map();
  const buckets = new Map();
  const latencies = [];
  const recent = [];

  const bump = (map, key, fields = {}) => {
    const current = map.get(key) ?? { requests: 0, errors: 0 };
    current.requests += 1;
    if (fields.error) current.errors += 1;
    if (fields.lastMs) current.lastMs = fields.lastMs;
    map.set(key, current);
  };

  function record(entry = {}) {
    const time = Number.isFinite(entry.time) ? entry.time : Date.now();
    const status = Number(entry.status) || 0;
    const durationMs = Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0;
    const failed = status >= 400;
    requests += 1;
    if (failed) errors += 1;
    latencySum += durationMs;
    latencyMax = Math.max(latencyMax, durationMs);
    latencies.push(durationMs);
    if (latencies.length > 1000) latencies.splice(0, latencies.length - 1000);

    statuses.set(String(status), (statuses.get(String(status)) ?? 0) + 1);
    bump(protocols, entry.protocol ?? 'local', { error: failed, lastMs: time });
    bump(groups, entry.group ?? 'unauthenticated', { error: failed, lastMs: time });
    authKinds.set(entry.auth ?? 'none', (authKinds.get(entry.auth ?? 'none') ?? 0) + 1);

    const bucketKey = Math.floor(time / bucketMs);
    const bucket = buckets.get(bucketKey) ?? { count: 0, errors: 0, latencyMs: 0 };
    bucket.count += 1;
    if (failed) bucket.errors += 1;
    bucket.latencyMs += durationMs;
    buckets.set(bucketKey, bucket);
    const oldest = bucketKey - bucketCount + 1;
    for (const key of buckets.keys()) if (key < oldest) buckets.delete(key);

    recent.unshift({
      time,
      requestId: typeof entry.requestId === 'string' ? entry.requestId : null,
      method: entry.method ?? null,
      protocol: entry.protocol ?? 'local',
      status,
      outcome: typeof entry.outcome === 'string' ? entry.outcome : (status >= 400 ? 'error' : 'success'),
      durationMs,
      group: entry.group ?? null,
      model: entry.model ?? null,
      auth: entry.auth ?? null,
    });
    if (recent.length > recentLimit) recent.length = recentLimit;
  }

  function percentile(sorted, fraction) {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return sorted[index];
  }

  function snapshot() {
    const now = Date.now();
    const currentBucket = Math.floor(now / bucketMs);
    const series = [];
    for (let offset = bucketCount - 1; offset >= 0; offset--) {
      const key = currentBucket - offset;
      const bucket = buckets.get(key);
      series.push({
        t: key * bucketMs,
        count: bucket?.count ?? 0,
        errors: bucket?.errors ?? 0,
        avgMs: bucket?.count ? Math.round(bucket.latencyMs / bucket.count) : 0,
      });
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      startedAt,
      uptimeMs: Math.max(0, now - startedAt),
      requests,
      errors,
      errorRate: requests ? errors / requests : 0,
      avgMs: requests ? Math.round(latencySum / requests) : 0,
      maxMs: latencyMax,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      byStatus: Object.fromEntries([...statuses.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      byProtocol: Object.fromEntries([...protocols.entries()]),
      byGroup: Object.fromEntries([...groups.entries()]),
      byAuth: Object.fromEntries([...authKinds.entries()]),
      buckets: series,
      recent: recent.slice(0, 100),
    };
  }

  function reset() {
    startedAt = Date.now();
    requests = 0;
    errors = 0;
    latencySum = 0;
    latencyMax = 0;
    statuses.clear(); protocols.clear(); groups.clear(); authKinds.clear(); buckets.clear(); latencies.length = 0; recent.length = 0;
  }

  return { record, snapshot, reset };
}
