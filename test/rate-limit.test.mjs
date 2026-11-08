import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRateLimits, normalizeGroupRateLimits, createRequestLimiter } from '../src/rate-limit.mjs';
test('limit configuration defaults to unlimited groups and accepts zero', () => {
  assert.deepEqual(normalizeGroupRateLimits(), { maxConcurrent: 0, rpm: 0 });
  assert.equal(normalizeRateLimits().api.rpm, 0);
  assert.equal(normalizeRateLimits().admin.maxConcurrent, 64);
  assert.equal(normalizeRateLimits({ admin: { loginRpm: 0 } }).admin.loginRpm, 0);
  for (const raw of [{ rpm: -1 }, { rpm: 0.5 }, { rpm: null }, { rpm: '0' }, { rpm: 100001 }, { typo: 1 }]) assert.throws(() => normalizeGroupRateLimits(raw));
  assert.throws(() => normalizeRateLimits({ unknown: {} }));
});
test('rolling RPM is shared by identity, independent between groups and expires at 60 seconds', () => {
  let time = 0;
  const limiter = createRequestLimiter({ now: () => time });
  const a = { id: 'group:a', rpm: 2, maxConcurrent: 0 };
  limiter.acquire([a])();
  time = 1000; limiter.acquire([a])();
  assert.throws(() => limiter.acquire([a]), error => error.status === 429 && error.retryAfter === 59);
  limiter.acquire([{ ...a, id: 'group:b' }])();
  time = 60000; limiter.acquire([a])();
});
test('concurrency release is idempotent and rejected requests reserve nothing', () => {
  const limiter = createRequestLimiter();
  const global = { id: 'global', rpm: 2, maxConcurrent: 1 };
  const release = limiter.acquire([global]);
  for (let i = 0; i < 3; i++) assert.throws(() => limiter.acquire([global, { id: 'group', rpm: 1 }]), { status: 429 });
  release(); release();
  limiter.acquire([global, { id: 'group', rpm: 1 }])();
});
test('unlimited RPM/concurrency and later concurrency changes preserve active requests', () => {
  const limiter = createRequestLimiter();
  const releases = Array.from({ length: 200 }, () => limiter.acquire([{ id: 'group', rpm: 0, maxConcurrent: 0 }]));
  assert.throws(() => limiter.acquire([{ id: 'group', rpm: 0, maxConcurrent: 1 }]), { status: 429 });
  releases.forEach(release => release());
  limiter.acquire([{ id: 'group', rpm: 0, maxConcurrent: 1 }])();
});
test('bounded identity and event stores fail closed without evicting active budgets', () => {
  let time = 0;
  const limiter = createRequestLimiter({ now: () => time, maxBuckets: 1, maxEvents: 1 });
  limiter.acquire([{ id: 'a', rpm: 1 }])();
  assert.throws(() => limiter.acquire([{ id: 'b', rpm: 1 }]), { status: 429 });
  time = 60001;
  limiter.acquire([{ id: 'b', rpm: 1 }])();
});
