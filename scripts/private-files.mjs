import { constants } from 'node:fs';
import { mkdir, open, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

const uid = () => process.geteuid();
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (directory, name) => '/proc/self/fd/' + directory.fd + '/' + name;
const unsafe = path => new Error('Unsafe deployment path (type, owner or links): ' + path);

// Linux deployment tools already rely on /proc and process groups. Walk each
// component through a held directory fd, never through a user-supplied symlink.
// Existing shared ancestors (/tmp, /run, /var/log) are NEVER chmodded.
async function directory(path, { create = false, privateLeaf = false } = {}) {
  const absolute = resolve(path);
  let handle = await open('/', directoryFlags);
  try {
    const parts = absolute.split('/').filter(Boolean);
    if (privateLeaf && parts.length === 0) throw unsafe(path);
    for (let i = 0; i < parts.length; i++) {
      const child = at(handle, parts[i]);
      let made = false;
      let next;
      try { next = await open(child, directoryFlags); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        try { await mkdir(child, { mode: 0o700 }); made = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        next = await open(child, directoryFlags);
      }
      await handle.close();
      handle = next;
      if (made || (privateLeaf && i === parts.length - 1)) {
        const info = await handle.stat();
        if (!info.isDirectory() || info.uid !== uid()) throw unsafe(path);
        await handle.chmod(0o700);
      }
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function ensurePrivateDirectory(path) {
  const handle = await directory(path, { create: true, privateLeaf: true });
  await handle.close();
}

export async function openPrivateFile(path, { create = false, append = false, exclusive = false } = {}) {
  const parent = await directory(dirname(resolve(path)), { create });
  let handle;
  try {
    let flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    if (create) flags |= constants.O_CREAT;
    if (append) flags |= constants.O_APPEND;
    if (exclusive) flags |= constants.O_EXCL;
    handle = await open(at(parent, basename(path)), flags, 0o600);
    const info = await handle.stat();
    // Refuse hard links too: chmod/write must not affect a different pathname.
    if (!info.isFile() || info.uid !== uid() || info.nlink !== 1) throw unsafe(path);
    await handle.chmod(0o600);
    return handle;
  } catch (error) { await handle?.close(); throw error; }
  finally { await parent.close(); }
}

export async function readPrivateFile(path) {
  let handle;
  try {
    handle = await openPrivateFile(path);
    return await handle.readFile('utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

export async function writePrivateFile(path, text) {
  const handle = await openPrivateFile(path, { create: true });
  try { await handle.truncate(0); await handle.writeFile(text); }
  finally { await handle.close(); }
}

export async function removePrivateFile(path) {
  let parent;
  let handle;
  try {
    parent = await directory(dirname(resolve(path)));
    const target = at(parent, basename(path));
    handle = await openPrivateFile(path);
    const [held, current] = await Promise.all([handle.stat(), lstat(target)]);
    if (held.dev !== current.dev || held.ino !== current.ino || !current.isFile()) throw unsafe(path);
    await unlink(target);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { await handle?.close(); await parent?.close(); }
}
