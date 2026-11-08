import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuth } from '../src/admin-auth.mjs';

test('admin password is stored as a salted scrypt hash only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-auth-'));
  const path = join(dir, 'admin-auth.private.json');
  const auth = new AdminAuth(path);
  const password = 'correct horse battery staple 42';
  await auth.setPassword(password);
  const text = await readFile(path, 'utf8');
  assert.equal(text.includes(password), false, 'plaintext password must never be written');
  const record = JSON.parse(text);
  assert.equal(record.algorithm, 'scrypt');
  assert.equal(record.version, 1);
  assert.ok(record.salt && record.hash);
  assert.equal(Buffer.from(record.salt, 'base64').length >= 16, true);
  assert.equal(Buffer.from(record.hash, 'base64').length >= 32, true);
  assert.equal((await stat(path)).mode & 0o077, 0, 'auth file must be 0600');
  assert.equal(await auth.verify(password), true);
  assert.equal(await auth.verify('wrong password'), false);
  const first = record;
  await auth.setPassword(password);
  const second = JSON.parse(await readFile(path, 'utf8'));
  assert.notEqual(first.salt, second.salt, 'each hash must use a fresh random salt');
  assert.notEqual(first.hash, second.hash, 'same password with a new salt must produce a different hash');
  await auth.remove();
  assert.deepEqual(await auth.status(), { configured: false });
});

test('admin password policy and file mode are enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-auth-policy-'));
  const path = join(dir, 'admin-auth.private.json');
  const auth = new AdminAuth(path);
  await assert.rejects(() => auth.setPassword('short'), /at least/i);
  await auth.setPassword('valid-password-123');
  await chmod(path, 0o644);
  await assert.rejects(() => auth.status(), /0600/);
});
