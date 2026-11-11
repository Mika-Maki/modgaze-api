// Shared HTTP/TLS budgets. Zero means unlimited; no proxy headers are trusted here.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  api: Object.freeze({ maxConcurrent: 0, rpm: 0, perKeyMaxConcurrent: 0, perKeyRpm: 0 }),
  admin: Object.freeze({ maxConcurrent: 64, rpm: 600, perIpMaxConcurrent: 32, perIpRpm: 300, loginMaxConcurrent: 2, loginRpm: 10 }),
});
function normalize(raw, defaults, label) {
  if (raw === undefined) return { ...defaults };
  if (!object(raw)) throw new Error('Invalid ' + label);
  for (const key of Object.keys(raw)) if (!Object.hasOwn(defaults, key)) throw new Error('Unknown ' + label + ' field: ' + key);
  const result = { ...defaults, ...raw };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new Error('Invalid ' + label + '.' + key + ': expected 0 (unlimited) to 100000');
  }
  return result;
}
export function normalizeGroupRateLimits(raw) {
  return normalize(raw, { maxConcurrent: 0, rpm: 0 }, 'group.rateLimits');
}
export function normalizeRateLimits(raw) {
  if (raw !== undefined && !object(raw)) throw new Error('Invalid rateLimits');
  for (const key of Object.keys(raw ?? {})) if (!Object.hasOwn(RATE_LIMIT_DEFAULTS, key)) throw new Error('Unknown rateLimits section: ' + key);
  return {
    api: normalize(raw?.api, RATE_LIMIT_DEFAULTS.api, 'rateLimits.api'),
    admin: normalize(raw?.admin, RATE_LIMIT_DEFAULTS.admin, 'rateLimits.admin'),
  };
}
export class RateLimitError extends Error {
  constructor(retryAfter = 1) {
    super('Request rate or concurrency limit exceeded');
    this.name = 'RateLimitError';
    this.status = 429;
    this.type = 'rate_limit_error';
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}
// Exact rolling 60-second window. Bounded bookkeeping fails closed for new
// identities rather than evicting live budgets and allowing a rate-limit bypass.
export function createRequestLimiter({ now = Date.now, maxBuckets = 10000, maxEvents = 250000 } = {}) {
  const buckets = new Map();
  let eventCount = 0;
  let cleanupTimer = null;
  function prune(bucket, time) {
    let first = bucket.first;
    while (first < bucket.events.length && bucket.events[first] <= time - 60000) first++;
    eventCount -= first - bucket.first;
    bucket.first = first;
    if (first && (first > 1024 || first === bucket.events.length)) {
      bucket.events = bucket.events.slice(first);
      bucket.first = 0;
    }
  }
  function collect(time) {
    for (const [id, bucket] of buckets) {
      prune(bucket, time);
      if (!bucket.active && bucket.first === bucket.events.length) buckets.delete(id);
    }
  }
  function scheduleCleanup(delay = 60000) {
    if (!eventCount) { clearTimeout(cleanupTimer); cleanupTimer = null; return; }
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = null;
      const time = now();
      collect(time);
      let next = time + 60000;
      for (const bucket of buckets.values()) {
        if (bucket.first < bucket.events.length) next = Math.min(next, bucket.events[bucket.first] + 60000);
      }
      scheduleCleanup(Math.max(1, next - time));
    }, delay);
    cleanupTimer.unref?.();
  }
  function acquire(rules) {
    const time = now();
    const ids = new Set();
    let newBuckets = 0;
    let newEvents = 0;
    for (const rule of rules) {
      if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)) throw new Error('Invalid or duplicate limiter identity');
      ids.add(rule.id);
      for (const key of ['maxConcurrent', 'rpm']) {
        const value = rule[key] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new Error('Invalid limiter ' + key);
      }
      if (!buckets.has(rule.id)) newBuckets++;
      if (rule.rpm) newEvents++;
    }
    if (buckets.size + newBuckets > maxBuckets || eventCount + newEvents > maxEvents) {
      collect(time);
      newBuckets = rules.filter(rule => !buckets.has(rule.id)).length;
      if (buckets.size + newBuckets > maxBuckets || eventCount + newEvents > maxEvents) throw new RateLimitError(1);
    }
    for (const rule of rules) {
      const bucket = buckets.get(rule.id);
      if (!bucket) continue;
      prune(bucket, time);
      if (rule.maxConcurrent && bucket.active >= rule.maxConcurrent) throw new RateLimitError(1);
      if (rule.rpm && bucket.events.length - bucket.first >= rule.rpm) {
        throw new RateLimitError((bucket.events[bucket.first] + 60000 - time) / 1000);
      }
    }
    const reserved = [];
    for (const rule of rules) {
      let bucket = buckets.get(rule.id);
      if (!bucket) { bucket = { active: 0, events: [], first: 0 }; buckets.set(rule.id, bucket); }
      bucket.active++;
      if (rule.rpm) { bucket.events.push(time); eventCount++; }
      reserved.push([rule.id, bucket]);
    }
    scheduleCleanup();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [id, bucket] of reserved) {
        bucket.active--;
        // Unlimited scopes need only keep in-flight counts. Limited scopes keep
        // the existing window even if their configuration is subsequently raised.
        if (!bucket.active && bucket.first === bucket.events.length) buckets.delete(id);
      }
    };
  }
  return { acquire };
}
