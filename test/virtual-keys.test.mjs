import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createRouter, compileConfig } from '../src/router.mjs';
const virtual = 'mr-local-test-credential';
const real = 'sk-provider-test-credential';
async function listen(t, server) {
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 t.after(async () => {server.closeAllConnections(); await new Promise(r => server.close(r));});
 return 'http://127.0.0.1:' + server.address().port;
}
const config = (baseURL, auth = 'bearer') => ({groups:[{id:'virtual',virtualApiKeys:[virtual],upstreamApiKey:real,routes:{responses:{baseURL,auth},messages:{baseURL,auth}},models:[{id:'model'}]}]});
for (const mode of ['json','sse','gzip','messages']) test('virtual key substitution and redaction: ' + mode, async t => {
 let received;
 const upstream = await listen(t, http.createServer((req,res) => {
  received = req.headers;
  req.resume();
  res.setHeader('x-request-id', real);
  const text = JSON.stringify({message: real + ' ' + virtual});
  if(mode === 'gzip') {res.setHeader('content-encoding','gzip');res.end(gzipSync(text));}
  else if(mode === 'sse') {res.setHeader('content-type','text/event-stream');res.write('data: '+real.slice(0,12));setImmediate(()=>res.end(real.slice(12)+' '+virtual+'\n\n'));}
  else res.end(text);
 }));
 const logs=[];
 const url = await listen(t,createRouter(config(upstream,mode === 'messages'?'x-api-key':'bearer'),{logger:r=>logs.push(r)}));
 const response = await fetch(url + (mode==='messages'?'/v1/messages':'/v1/responses'),{method:'POST',headers:mode==='messages'?{'x-api-key':virtual}:{authorization:'Bearer '+virtual},body:JSON.stringify({model:'model',input:'hello'})});
 assert.equal(response.status,200);
 const body = await response.text();
 assert.ok(!body.includes(real) && !body.includes(virtual));
 assert.ok(body.includes('[REDACTED]'));
 assert.equal(response.headers.get('x-request-id'),'[REDACTED]');
 assert.equal(mode==='messages'?received['x-api-key']:received.authorization,mode==='messages'?real:'Bearer '+real);
 assert.ok(!JSON.stringify(logs).includes(real) && !JSON.stringify(logs).includes(virtual));
 if(mode==='gzip') assert.equal(response.headers.get('content-encoding'),null);
});
test('virtual keys without upstream replacement fail closed',()=>{
 const c=config('http://127.0.0.1:1');delete c.groups[0].upstreamApiKey;
 assert.throws(()=>compileConfig(c),/upstreamApiKey/);
});
test('upstream cannot equal a virtual credential',()=>{
 const c=config('http://127.0.0.1:1');c.groups[0].upstreamApiKey=virtual;
 assert.throws(()=>compileConfig(c),/virtual API key/);
});
test('duplicate virtual credential is rejected',()=>{
 const c=config('http://127.0.0.1:1');c.groups[0].apiKeys=[virtual];assert.throws(()=>compileConfig(c),/Duplicate/);
});
