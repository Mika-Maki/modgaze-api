import { watch as watchDirectory } from 'node:fs';
import { basename, dirname } from 'node:path';

// Watch the directory so atomic replacement does not strand an inode watch.
// Events only schedule a secure read; authentication independently checks expiry.
export function createMRExpiryCleaner(store, { intervalMs = 1000, rescanMs = 60000, now = Date.now,
  watch = watchDirectory, onRemoved = () => {}, onError = () => {} } = {}) {
  for (const value of [intervalMs, rescanMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid MR expiry cleanup interval');
  }
  let stopped = false, pending = null, dirty = false, timer = null, watcher = null;
  let nextExpiry = Infinity, failed = false;
  const report = error => { try { onError(error); } catch {} };
  const background = () => { void run().catch(report); };
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (stopped || pending) return;
    const untilExpiry = nextExpiry - now();
    const delay = Math.min(watcher && !failed ? rescanMs : intervalMs, untilExpiry > 0 ? untilExpiry : intervalMs);
    timer = setTimeout(background, Math.max(1, delay));
    timer.unref?.();
  }
  function changed() {
    if (stopped) return;
    if (pending) dirty = true;
    else background();
  }
  function watchFailed() {
    const previous = watcher;
    watcher = null;
    try { previous?.close(); } catch {}
    schedule();
  }
  if (typeof store.configPath === 'string') {
    try {
      watcher = watch(dirname(store.configPath), (event, name) => {
        if (name == null || String(name) === basename(store.configPath)) changed();
      });
      watcher.on('error', watchFailed);
      watcher.on('close', () => { if (watcher) watchFailed(); });
      watcher.unref?.();
    } catch { watcher = null; }
  }
  function run() {
    if (stopped) return Promise.resolve({ removed: [] });
    if (pending) return pending;
    clearTimeout(timer);
    timer = null;
    dirty = false;
    pending = Promise.resolve().then(() => store.removeExpiredMRKeys(now())).then(result => {
      failed = false;
      nextExpiry = typeof result.nextExpiry === 'number' ? result.nextExpiry : Infinity;
      if (result.removed.length) { try { onRemoved(result.removed); } catch (error) { report(error); } }
      return result;
    }, error => { failed = true; throw error; }).finally(() => {
      pending = null;
      if (dirty && !stopped && !failed) background();
      else schedule();
    });
    return pending;
  }
  schedule();
  return {
    run,
    async close() {
      stopped = true;
      clearTimeout(timer);
      const previous = watcher; watcher = null;
      try { previous?.close(); } catch {}
      if (pending) await pending.catch(() => {});
    },
  };
}
