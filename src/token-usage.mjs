import { createHash } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTokenBackups } from './token-backups.mjs';

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'];
const LIMIT_FIELDS = ['totalTokens', 'inputTokens', 'outputTokens', 'cachedTokens', 'dayTokens'];
const COLUMNS = ['input_tokens', 'output_tokens', 'cached_tokens', 'total_tokens'];
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const APPLICATION_ID = 1297568853;
// This queue only orders disk operations; it never contains token balances.
const directories = new Map();

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

export function normalizeTokenLimits(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('tokenLimits must be an object');
  for (const field of Object.keys(raw)) {
    if (!LIMIT_FIELDS.includes(field)) throw new TypeError(`Unknown tokenLimits field: ${field}`);
  }
  return Object.fromEntries(LIMIT_FIELDS.map(field => [field, raw[field] === undefined ? 0 : integer(raw[field], `tokenLimits.${field}`)]));
}

function keyIdentity(keyId) {
  if (typeof keyId !== 'string' || !/^[a-f0-9]{64}$/.test(keyId)) throw new TypeError('keyId must be a full lowercase SHA-256 digest');
  return keyId;
}

function localDay(time) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid token usage time');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function unavailable(cause) {
  return Object.assign(new Error('Persistent token usage is unavailable', { cause }), {
    status: 503, statusCode: 503, type: 'token_usage_unavailable', code: 'token_usage_unavailable',
  });
}

function assertRegularFile(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe token ledger file');
  return stat;
}

function prepareDirectory(directory) {
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe token ledger directory');
  }
  const handle = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fchmodSync(handle, 0o700); } finally { closeSync(handle); }
}

function secureFiles(filename) {
  for (const path of [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`]) {
    const stat = assertRegularFile(path);
    if (stat && path !== filename && (stat.mode & 0o777) !== 0o600) throw new Error('Unsafe token ledger permissions');
  }
}

function emptyTotals() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, requests: 0,
    observed: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 } };
}

function totalsFromRow(row) {
  if (!row) return emptyTotals();
  const result = { requests: row.requests, observed: {} };
  TOKEN_FIELDS.forEach((field, index) => {
    result[field] = row[COLUMNS[index]];
    result.observed[field] = row[`observed_${COLUMNS[index]}`];
  });
  return result;
}

/**
 * Disk is authoritative: every read runs a SQLite query, every write is one
 * FULL-synchronous WAL transaction. The request digest table grows by one small
 * row per measured request so retries remain idempotent across restarts.
 */
export function createTokenUsageStore({ directory, now = Date.now, onBackupError = () => console.error(JSON.stringify({ event: 'token_backup_error' })) } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('Token usage directory is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  directory = resolve(directory);
  const filename = join(directory, 'usage.sqlite');
  const backups = createTokenBackups(directory, now);
  let shared = directories.get(directory);
  if (!shared) { shared = { tail: Promise.resolve(), failure: null, references: 0 }; directories.set(directory, shared); }
  shared.references++;
  let database;
  let fileIdentity;
  let directoryIdentity;
  let closed = false;
  let closing = false;
  let closePromise;

  function verifyIdentity() {
    const file = assertRegularFile(filename);
    const folder = lstatSync(directory);
    if (!file || file.dev !== fileIdentity.dev || file.ino !== fileIdentity.ino || (file.mode & 0o777) !== 0o600
      || !folder.isDirectory() || folder.isSymbolicLink() || folder.dev !== directoryIdentity.dev
      || folder.ino !== directoryIdentity.ino || (folder.mode & 0o777) !== 0o700) {
      throw new Error('Token ledger identity or permissions changed');
    }
    secureFiles(filename);
  }

  function openDatabase() {
    if (database) { verifyIdentity(); return database; }
    prepareDirectory(directory);
    directoryIdentity = lstatSync(directory);
    secureFiles(filename);
    const handle = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe token ledger file');
      fchmodSync(handle, 0o600);
      fileIdentity = stat;
    } finally { closeSync(handle); }
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-32; PRAGMA wal_autocheckpoint=64; PRAGMA trusted_schema=OFF;');
      db.exec('BEGIN IMMEDIATE');
      try {
        const version = db.prepare('PRAGMA user_version').get().user_version;
        const application = db.prepare('PRAGMA application_id').get().application_id;
        if (version === 0 && application === 0) {
          if (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count !== 0) throw new Error('Unrecognized token ledger');
          const counters = [...COLUMNS, 'requests', ...COLUMNS.map(column => `observed_${column}`)];
          db.exec(`
            CREATE TABLE usage_totals (
              identity TEXT NOT NULL, period TEXT NOT NULL,
              ${counters.map(column => `${column} INTEGER NOT NULL CHECK(typeof(${column})='integer' AND ${column} BETWEEN 0 AND ${MAX_INTEGER})`).join(',')},
              PRIMARY KEY(identity, period)
            ) WITHOUT ROWID;
            CREATE TABLE measured_requests (digest BLOB PRIMARY KEY NOT NULL CHECK(length(digest)=32)) WITHOUT ROWID;
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          `);
        } else if (version !== 1 || application !== APPLICATION_ID) {
          throw new Error('Unsupported token ledger schema');
        }
        db.exec('CREATE TABLE IF NOT EXISTS backup_state (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      verifyIdentity();
      database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  function enqueue(operation, { fatal = true } = {}) {
    if (closing || closed) return Promise.reject(unavailable(new Error('Token ledger is closed')));
    const result = shared.tail.then(() => {
      if (shared.failure) throw unavailable(shared.failure);
      try { return operation(openDatabase()); } catch (error) {
        // Never accept more traffic after a write/read failure with an uncertain balance.
        if (fatal) shared.failure = error;
        throw unavailable(error);
      }
    });
    shared.tail = result.catch(() => {});
    return result;
  }

  function readSnapshot(db, keyId, time) {
    const day = localDay(time);
    const select = db.prepare('SELECT * FROM usage_totals WHERE identity=? AND period=?');
    db.exec('BEGIN');
    try {
      const total = totalsFromRow(select.get(keyId ?? '', ''));
      const today = totalsFromRow(select.get(keyId ?? '', day));
      db.exec('COMMIT');
      return { day, date: day, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, total, today };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  return {
    async record({ requestId, keyId, usage, time } = {}) {
      keyIdentity(keyId);
      if (typeof requestId !== 'string' || !requestId || requestId.length > 1024) throw new TypeError('requestId must be a nonempty string of at most 1024 characters');
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new TypeError('usage must be an object');
      const present = TOKEN_FIELDS.map(field => usage[field] !== undefined && usage[field] !== null);
      const values = TOKEN_FIELDS.map((field, index) => present[index] ? integer(usage[field], field) : 0);
      if (!present.some(Boolean)) return { recorded: false };
      if (!present[3]) values[3] = integer(values[0] + values[1], 'derived totalTokens');
      const day = localDay(time ?? now());
      const digest = createHash('sha256').update(requestId).digest();
      return enqueue(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const inserted = db.prepare('INSERT OR IGNORE INTO measured_requests(digest) VALUES (?)').run(digest).changes;
          if (inserted) {
            const counters = [...COLUMNS, 'requests', ...COLUMNS.map(column => `observed_${column}`)];
            const update = db.prepare(`INSERT INTO usage_totals(identity,period,${counters.join(',')})
              VALUES (${Array(counters.length + 2).fill('?').join(',')})
              ON CONFLICT(identity,period) DO UPDATE SET ${counters.map(column => `${column}=${column}+excluded.${column}`).join(',')}`);
            const params = [...values, 1, ...present.map(Number)];
            for (const identity of ['', keyId]) {
              for (const period of ['', day]) update.run(identity, period, ...params);
            }
          }
          db.exec('COMMIT');
          if (inserted) {
            // Activity-driven: no timer or file scan while idle. A failed backup
            // never rolls back committed usage, and the next write retries it.
            try {
              const backupDay = localDay(now());
              const previous = db.prepare('SELECT value FROM backup_state WHERE name=?').get('automatic_day');
              if (previous?.value !== backupDay) {
                backups.create(db, 'auto');
                db.prepare('INSERT INTO backup_state(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run('automatic_day', backupDay);
              }
            } catch { try { onBackupError(); } catch {} }
          }
          return { recorded: Boolean(inserted) };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    },
    async snapshot({ keyId } = {}) {
      if (keyId !== undefined) keyIdentity(keyId);
      const time = now();
      localDay(time);
      return enqueue(db => readSnapshot(db, keyId, time));
    },
    async check(keyId, rawLimits = {}) {
      keyIdentity(keyId);
      const limits = normalizeTokenLimits(rawLimits);
      const time = now();
      localDay(time);
      const snapshot = await enqueue(db => readSnapshot(db, keyId, time));
      for (const field of LIMIT_FIELDS) {
        const used = field === 'dayTokens' ? snapshot.today.totalTokens : snapshot.total[field];
        if (limits[field] > 0 && used >= limits[field]) {
          const error = Object.assign(new Error(`Token quota exceeded: ${field}`), {
            status: 429, statusCode: 429, type: 'token_quota_exceeded', code: 'token_quota_exceeded', field,
          });
          if (field === 'dayTokens') {
            const tomorrow = new Date(time);
            tomorrow.setHours(24, 0, 0, 0);
            error.retryAfter = Math.max(1, Math.ceil((tomorrow.getTime() - Number(new Date(time))) / 1000));
          }
          throw error;
        }
      }
      return snapshot;
    },
    createBackup() { return enqueue(db => backups.create(db), { fatal: false }); },
    listBackups() { return enqueue(() => backups.list(), { fatal: false }); },
    openBackup(name) { return enqueue(() => backups.open(name), { fatal: false }); },
    async drain() { await shared.tail; if (shared.failure) throw unavailable(shared.failure); },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = shared.tail.then(() => {
        try { if (database) { database.close(); database = undefined; } } finally {
          closed = true;
          shared.references--;
          if (shared.references === 0 && directories.get(directory) === shared) directories.delete(directory);
        }
      });
      shared.tail = closePromise.catch(() => {});
      return closePromise;
    },
  };
}
