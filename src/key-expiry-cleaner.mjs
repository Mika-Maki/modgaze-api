// Share the exact ConfigStore queue with WebUI edits: a renewal and a sweep
// cannot overwrite each other from stale snapshots. Authentication separately
// rejects expired keys immediately, even if a disk write/backup temporarily fails.
export function createMRExpiryCleaner(store, { intervalMs = 1000, now = Date.now, onRemoved = () => {}, onError = () => {} } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid MR expiry cleanup interval');
  let stopped = false;
  let pending = null;
  function run() {
    if (stopped) return Promise.resolve({ removed: [] });
    if (pending) return pending;
    pending = Promise.resolve().then(() => store.removeExpiredMRKeys(now())).then(result => {
      if (result.removed.length) onRemoved(result.removed);
      return result;
    }).finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void run().catch(error => { try { onError(error); } catch {} }); }, intervalMs);
  timer.unref?.();
  return {
    run,
    async close() { stopped = true; clearInterval(timer); if (pending) await pending.catch(() => {}); },
  };
}
