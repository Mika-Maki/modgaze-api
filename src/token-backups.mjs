import { randomBytes } from 'node:crypto';
import { constants, closeSync, createReadStream, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TOKEN_BACKUP_POLICY = Object.freeze({ automatic: 'daily-on-write', keepAuto: 7, keepManual: 10 });
const NAME = /^(auto|manual)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{12}\.sqlite$/;
const HEADER = Buffer.from('SQLite format 3\0');

// All filenames are generated here. No client text is ever used as SQL or a path.
export function createTokenBackups(directory, now = Date.now) {
  const folder = join(directory, 'backups');
  function ensureFolder() {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) throw new Error('Unsafe token backup parent');
    try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('Unsafe token backup directory');
  }
  function info(name) {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Invalid token backup name');
    const stat = lstatSync(join(folder, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error('Unsafe token backup file');
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  function list() {
    ensureFolder();
    const entries = [];
    for (const name of readdirSync(folder)) {
      if (!NAME.test(name)) continue;
      try { entries.push(info(name)); } catch { /* Never expose unsafe or incomplete files. */ }
    }
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  }
  function prune(protectedName) {
    const entries = list();
    for (const [kind, keep] of [['auto', TOKEN_BACKUP_POLICY.keepAuto], ['manual', TOKEN_BACKUP_POLICY.keepManual]]) {
      const matching = entries.filter(entry => entry.name.startsWith(kind + '-'));
      matching.sort((a, b) => Number(b.name === protectedName) - Number(a.name === protectedName));
      for (const entry of matching.slice(keep)) unlinkSync(join(folder, entry.name));
    }
  }
  function create(db, kind = 'manual') {
    if (!['manual', 'auto'].includes(kind)) throw new Error('Invalid token backup kind');
    ensureFolder();
    const suffix = randomBytes(6).toString('hex');
    const name = kind + '-' + new Date(now()).toISOString().replace(/[:.]/g, '-') + '-' + suffix + '.sqlite';
    const temporary = join(folder, '.pending-' + suffix + '.sqlite');
    let handle = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(handle);
    try {
      // VACUUM creates a consistent standalone database, including committed WAL
      // frames. The destination is a bound value, never interpolated into SQL.
      db.prepare('VACUUM INTO ?').run(temporary);
      const check = new DatabaseSync(temporary, { readOnly: true });
      try {
        if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || check.prepare('PRAGMA application_id').get().application_id !== 1297568853) throw new Error('Invalid token backup snapshot');
      } finally { check.close(); }
      handle = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fchmodSync(handle, 0o600); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temporary, join(folder, name));
      handle = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(handle); } finally { closeSync(handle); }
      prune(name);
      return info(name);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }
  function open(name) {
    ensureFolder();
    info(name);
    const path = join(folder, name);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd), header = Buffer.alloc(16);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || readSync(fd, header, 0, 16, 0) !== 16 || !header.equals(HEADER)) throw new Error('Unsafe token backup file');
      return { name, size: stat.size, stream: createReadStream(path, { fd, autoClose: true, start: 0 }) };
    } catch (error) { closeSync(fd); throw error; }
  }
  return { create, list, open };
}
