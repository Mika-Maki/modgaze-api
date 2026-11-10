// Audit-only probe. Fake credentials, ephemeral loopback listeners, no live config.
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRouter } from '../src/router.mjs';
const exec = promisify(execFile);
const calls = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ body, url: req.url, sharedCredential: req.headers.authorization === 'Bearer audit-shared-upstream' });
  // This is only a mock authority: no real provider object is accessed.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'resp_audit_' + calls.length, object: 'response', mock: true, output_text: 'SYNTHETIC_SHARED_RESOURCE' }));
});
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; }
let router;
try {
  const upstreamURL = await listen(upstream);
  router = createRouter({ requestTimeoutMs: 3000, upstreamTimeoutMs: 2000, groups: [{ id: 'shared-project', virtualApiKeys: ['audit-tenant-a', 'audit-tenant-b'], upstreamApiKey: 'audit-shared-upstream', routes: { responses: { baseURL: upstreamURL }, chat: { baseURL: upstreamURL } }, models: [{ id: 'audit-model' }] }] });
  const origin = await listen(router);
  const cases = [
    ['response-file-reference', '/v1/responses', { model: 'audit-model', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_other_tenant' }] }] }],
    ['vector-store-reference', '/v1/responses', { model: 'audit-model', input: 'Search the uploaded files.', tools: [{ type: 'file_search', vector_store_ids: ['vs_other_tenant'] }] }],
    ['container-reference', '/v1/responses', { model: 'audit-model', input: 'List the files in the container.', tools: [{ type: 'code_interpreter', container: 'cntr_other_tenant' }] }],
    ['chat-file-reference', '/v1/chat/completions', { model: 'audit-model', messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file_other_tenant' } }] }] }],
  ];
  for (const [name, path, body] of cases) {
    const args = ['--noproxy', '*', '--silent', '--show-error', '--max-time', '5', '-X', 'POST', origin + path, '-H', 'Authorization: Bearer audit-tenant-b', '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body), '-w', '\nHTTP_STATUS=%{http_code}\n'];
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    console.log('CASE=' + name);
    console.log('curl ' + args.map(quote).join(' '));
    const { stdout } = await exec('curl', args);
    console.log(stdout.trim()); console.log('CURL_EXIT=0');
    assert.match(stdout, /HTTP_STATUS=403/);
    assert.match(stdout, /resource_reference_error/);
    assert.equal(calls.length, 0);
    console.log('UNTRACKED_REFERENCE_BLOCKED_BEFORE_UPSTREAM=true');
  }
  const before = calls.length;
  const denied = await fetch(origin + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer audit-tenant-b', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'audit-model', input: 'x', previous_response_id: 'resp_unknown_owner' }) });
  assert.equal(denied.status, 404); await denied.text(); assert.equal(calls.length, before);
  console.log('CONTROL_UNKNOWN_PREVIOUS_RESPONSE=404; UPSTREAM_CALLS_UNCHANGED=true');
  console.log('AUDIT_PROBES_PASSED=5; MOCK_ONLY=true');
} finally {
  for (const server of [router, upstream].filter(Boolean)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
