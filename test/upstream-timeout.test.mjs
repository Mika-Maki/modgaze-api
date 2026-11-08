import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setImmediate as tick } from 'node:timers/promises';
import { createRouter } from '../src/router.mjs';

// Preserve the downstream transport before the per-subtest upstream mock.
const clientRequest = http.request.bind(http);
const hostname = 'slow-lookup.test';

async function serve(t, server) {
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function request(port) {
  return new Promise((resolve, reject) => {
    const req = clientRequest({
      hostname: '127.0.0.1', port, path: '/v1/responses', method: 'POST', agent: false,
      headers: { authorization: 'Bearer timeout-test-key', 'content-type': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('test client timeout')));
    req.end(JSON.stringify({ model: 'timeout-model', input: 'hello' }));
  });
}

async function certificate(t) {
  const directory = await mkdtemp(join(tmpdir(), 'amerge-upstream-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'server.key');
  const certFile = join(directory, 'server.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=' + hostname,
    '-addext', 'subjectAltName=DNS:' + hostname,
  ], { stdio: 'ignore' });
  await chmod(keyFile, 0o600);
  return { key: await readFile(keyFile), cert: await readFile(certFile) };
}

async function fixture(t, protocol, tls, {
  agentTimeoutMs = 50, lookupDelayMs = 200, upstreamTimeoutMs = 1000, requestTimeoutMs = 2000,
} = {}) {
  const transport = protocol === 'https' ? https : http;
  const agent = new transport.Agent({
    keepAlive: false, timeout: agentTimeoutMs,
    ...(protocol === 'https' ? { ca: tls.cert } : {}),
  });
  const pendingLookups = new Set();
  const lookupTasks = [];
  const requests = [];
  const records = [];
  let delay = lookupDelayMs;
  let hits = 0;
  let lookups = 0;
  let completedLookups = 0;
  t.after(() => {
    agent.destroy();
    for (const timer of pendingLookups) clearTimeout(timer);
    pendingLookups.clear();
  });
  const handler = (req, res) => {
    hits++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  const upstream = protocol === 'https' ? https.createServer(tls, handler) : http.createServer(handler);
  const upstreamPort = await serve(t, upstream);
  const lookup = (_name, options, callback) => {
    lookups++;
    lookupTasks.push(new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingLookups.delete(timer);
        completedLookups++;
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
        resolve();
      }, delay);
      pendingLookups.add(timer);
    }));
  };
  const original = transport.request;
  t.mock.method(transport, 'request', function (target, options, ...rest) {
    if (!(target instanceof URL) || target.hostname !== hostname || Number(target.port) !== upstreamPort) {
      return original.call(this, target, options, ...rest);
    }
    // ONLY inject the isolated Agent and delayed DNS. In particular do not add,
    // remove or change options.timeout: the router itself must supply it.
    const outgoing = original.call(this, target, { ...options, agent, lookup }, ...rest);
    const observed = { outgoing, timeout: options.timeout, socket: null, closed: null };
    observed.closed = new Promise(resolve => outgoing.once('close', resolve));
    outgoing.once('socket', socket => { observed.socket = socket; });
    requests.push(observed);
    return outgoing;
  });
  t.after(() => t.mock.restoreAll());
  const config = {
    upstreamTimeoutMs, requestTimeoutMs,
    rateLimits: { api: { maxConcurrent: 1 } },
    groups: [{
      id: 'timeout-test', apiKeys: ['timeout-test-key'],
      routes: { responses: { baseURL: protocol + '://' + hostname + ':' + upstreamPort } },
      models: [{ id: 'timeout-model' }],
    }],
  };
  const router = createRouter(config, { onRequest: record => records.push(record) });
  const port = await serve(t, router);
  return {
    agent, requests, records, request: () => request(port),
    get hits() { return hits; },
    get lookups() { return lookups; },
    get completedLookups() { return completedLookups; },
    immediateLookup() { delay = 0; },
    async settled() {
      await Promise.all(lookupTasks);
      await Promise.all(requests.map(item => item.closed));
      await tick();
      await tick();
      assert.equal(pendingLookups.size, 0, 'all delayed DNS callbacks completed');
      assert.ok(requests.every(item => item.outgoing.destroyed), 'upstream requests destroyed');
      assert.ok(requests.every(item => item.socket?.destroyed), 'upstream sockets destroyed');
      assert.deepEqual(Object.keys(agent.sockets), [], 'no active Agent sockets');
      assert.deepEqual(Object.keys(agent.freeSockets), [], 'no pooled Agent sockets');
      assert.deepEqual(Object.keys(agent.requests), [], 'no queued Agent requests');
    },
  };
}

// Subtests are deliberately awaited, never concurrent: http(s).request is a
// module-global mock. Node's test runner isolates this file from other files.
test('upstream timeout starts before connect, including delayed DNS', { concurrency: false, timeout: 30000 }, async t => {
  const tls = await certificate(t);
  for (const protocol of ['http', 'https']) {
    await t.test(protocol + ': configured timeout overrides a short Agent timeout during lookup', async t => {
      const f = await fixture(t, protocol, tls);
      const result = await f.request();
      // Without timeout in request options, the 50ms Agent timeout produces 504
      // before the 200ms lookup finishes, despite request.setTimeout(1000).
      assert.equal(result.status, 200, result.body);
      assert.deepEqual(JSON.parse(result.body), { ok: true });
      assert.equal(f.requests[0].timeout, 1000, 'constructor receives configured idle timeout');
      assert.equal(f.lookups, 1);
      assert.equal(f.completedLookups, 1);
      assert.equal(f.hits, 1);
      await f.settled();
      assert.deepEqual(f.records.map(record => record.status), [200]);
    });

    await t.test(protocol + ': configured idle timeout during DNS returns 504 and releases resources', async t => {
      const f = await fixture(t, protocol, tls, {
        agentTimeoutMs: 1000, lookupDelayMs: 250, upstreamTimeoutMs: 80, requestTimeoutMs: 2000,
      });
      const result = await f.request();
      assert.equal(result.status, 504, result.body);
      assert.match(JSON.parse(result.body).error.message, /Upstream idle timeout/);
      assert.equal(f.requests[0].timeout, 80);
      assert.equal(f.completedLookups, 0, 'timeout fires while DNS is still pending');
      await f.settled();
      assert.equal(f.hits, 0, 'late DNS completion must not resurrect the upstream request');
      assert.deepEqual(f.records.map(record => record.status), [504], 'finalization happens once');
      f.immediateLookup();
      assert.equal((await f.request()).status, 200, 'concurrency admission was released');
      await f.settled();
      assert.deepEqual(f.records.map(record => record.status), [504, 200]);
    });

    await t.test(protocol + ': total deadline during DNS still returns 504 and releases resources', async t => {
      const f = await fixture(t, protocol, tls, {
        agentTimeoutMs: 1000, lookupDelayMs: 300, upstreamTimeoutMs: 1000, requestTimeoutMs: 100,
      });
      const result = await f.request();
      assert.equal(result.status, 504, result.body);
      const error = JSON.parse(result.body).error;
      assert.equal(error.type, 'timeout_error');
      // Both timers are capped at remaining deadline and may race legitimately.
      assert.match(error.message, /Upstream (request deadline exceeded|idle timeout)/);
      assert.ok(f.requests[0].timeout > 0 && f.requests[0].timeout <= 100,
        'constructor timeout is capped at the remaining total deadline');
      assert.equal(f.completedLookups, 0, 'deadline fires while DNS is still pending');
      await f.settled();
      assert.equal(f.hits, 0);
      assert.deepEqual(f.records.map(record => record.status), [504]);
      f.immediateLookup();
      assert.equal((await f.request()).status, 200, 'deadline failure releases concurrency admission');
      await f.settled();
      assert.deepEqual(f.records.map(record => record.status), [504, 200]);
    });
  }

  await t.test('http: lookup lasting more than five seconds succeeds within configured budgets', async t => {
    const f = await fixture(t, 'http', tls, {
      agentTimeoutMs: 5000, lookupDelayMs: 5300, upstreamTimeoutMs: 8000, requestTimeoutMs: 10000,
    });
    const started = performance.now();
    const result = await f.request();
    assert.equal(result.status, 200, result.body);
    assert.ok(performance.now() - started >= 5000, 'exercise the actual five-second boundary');
    assert.equal(f.requests[0].timeout, 8000);
    assert.equal(f.completedLookups, 1);
    assert.equal(f.hits, 1);
    await f.settled();
    assert.deepEqual(f.records.map(record => record.status), [200]);
  });
});
