import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../src/router.mjs';
import { validateResourceReferences } from '../src/resource-policy.mjs';
const model = 'resource-model';
const input = block => [{ role: 'user', content: [block] }];
const cases = [
  ['responses-file', 'responses', { input: input({ type: 'input_file', file_id: 'file_foreign' }) }],
  ['responses-image', 'responses', { input: input({ type: 'input_image', file_id: 'file_foreign' }) }],
  ['vector-store', 'responses', { tools: [{ type: 'file_search', vector_store_ids: ['vs_foreign'] }] }],
  ['existing-container', 'responses', { tools: [{ type: 'code_interpreter', container: 'cntr_foreign' }] }],
  ['container-files', 'responses', { tools: [{ type: 'code_interpreter', container: { type: 'auto', file_ids: ['file_foreign'] } }] }],
  ['container-object-id', 'responses', { tools: [{ type: 'code_interpreter', container: { type: 'auto', id: 'cntr_foreign' } }] }],
  ['implicit-container', 'responses', { tools: [{ type: 'code_interpreter' }] }],
  ['saved-prompt', 'responses', { prompt: { id: 'pmpt_foreign', variables: {} } }],
  ['function-output-file', 'responses', { input: [{type:'function_call_output',call_id:'call_local',output:[{type:'input_file',file_id:'file_foreign'}]}] }],
  ['chat-file', 'chat', { messages: input({ type: 'file', file: { file_id: 'file_foreign' } }) }],
  ['chat-stored-audio', 'chat', { messages: [{role:'assistant',audio:{id:'audio_foreign'}}] }],
  ['anthropic-file', 'messages', { messages: input({ type: 'document', source: { type:'file', file_id:'file_foreign' } }) }],
  ['anthropic-tool-result', 'messages', { messages: input({ type:'tool_result',tool_use_id:'tool_local',content:[{type:'image',source:{type:'file',file_id:'file_foreign'}}] }) }],
  ['anthropic-container', 'messages', { container: 'cntr_foreign', messages: [] }],
  ['anthropic-container-upload', 'messages', { messages: input({type:'container_upload',file_id:'file_foreign'}) }],
  ['alias-slot', 'responses', { input: input({type:'input_file',File_ID:'file_foreign'}) }],
];
const paths={responses:'/v1/responses',chat:'/v1/chat/completions',messages:'/v1/messages'};
async function fixture(t) {
  const calls=[], logs=[];
  const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);calls.push(JSON.parse(Buffer.concat(chunks)));res.writeHead(200,{'content-type':'application/json'});res.end('{"id":"resp_local"}');});
  const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
  const upstreamURL=await listen(upstream);
  const config={requestTimeoutMs:3000,groups:[{id:'shared',virtualApiKeys:['tenant-a','tenant-b'],upstreamApiKey:'synthetic-upstream',routes:Object.fromEntries(Object.keys(paths).map(p=>[p,{baseURL:upstreamURL}])),models:[{id:model}]}]};
  const router=createRouter(config,{logger:entry=>logs.push(entry)});const origin=await listen(router);
  t.after(async()=>{for(const server of [router,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
  const send=async(protocol,extra,key='tenant-b',suffix='')=>{const response=await fetch(origin+paths[protocol]+suffix,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model,...extra})});return {status:response.status,body:await response.json()};};
  return {calls,logs,config,router,send};
}
for(const [name,protocol,body] of cases) test('unowned provider resource is rejected before upstream: '+name,async t=>{
  const f=await fixture(t);
  for(const key of ['tenant-a','tenant-b']) {
    const result=await f.send(protocol,body,key);
    assert.equal(result.status,403);assert.equal(result.body.error.type,'resource_reference_error');
  }
  assert.equal(f.calls.length,0);assert.equal(f.logs.length,2);
  assert.ok(f.logs.every(entry=>entry.outcome==='resource_reference_error'));
  assert.doesNotMatch(JSON.stringify(f.logs),/file_foreign|vs_foreign|cntr_foreign|synthetic-upstream|tenant-a|tenant-b/);
});
test('resource query aliases and defaults cannot bypass checks',async t=>{
  const f=await fixture(t);
  for(const suffix of ['?file_id=file_foreign','?tools[0][vector_store_ids][]=vs_foreign','?Container=cntr_foreign','?prompt[id]=pmpt_foreign'])assert.equal((await f.send('responses',{input:'hi'},'tenant-b',suffix)).status,403);
  f.config.groups[0].models[0].defaults={responses:{tools:[{type:'file_search',vector_store_ids:['vs_foreign']}]}};f.router.reload(f.config);
  assert.equal((await f.send('responses',{input:'hi'})).status,403);assert.equal(f.calls.length,0);
});
test('inline content and opaque user/schema fields remain usable',async t=>{
  const f=await fixture(t);
  const opaque={file_id:'not-authority',vector_store_ids:['not-authority'],container:'not-authority',type:'item_reference'};
  const bodies={
    responses:{input:[...input({type:'input_file',filename:'test.txt',file_data:'data:text/plain;base64,aGk='}),{type:'function_call',call_id:'call_local',name:'echo',arguments:JSON.stringify(opaque)}],tools:[{type:'function',name:'echo',parameters:{type:'object',properties:opaque}},{type:'code_interpreter',container:{type:'auto',file_ids:[]}}],metadata:opaque},
    chat:{messages:input({type:'file',file:{filename:'test.txt',file_data:'data:text/plain;base64,aGk='}}),tools:[{type:'function',function:{name:'echo',parameters:opaque}}],metadata:opaque},
    messages:{messages:[...input({type:'document',source:{type:'base64',media_type:'application/pdf',data:'AA=='}}),{role:'assistant',content:[{type:'tool_use',id:'tool_local',name:'echo',input:opaque}]}],tools:[{name:'echo',input_schema:opaque}],metadata:opaque},
  };
  for(const [protocol,body] of Object.entries(bodies)) {assert.equal((await f.send(protocol,body)).status,200);assert.deepEqual(f.calls.at(-1),{model,...body});}
});
test('wide semantic arrays do not use spread argument calls',()=>{
  const body={input:[{role:'user',content:Array.from({length:150000},()=>({type:'input_text',text:'x'}))}]};
  assert.doesNotThrow(()=>validateResourceReferences(body,'responses'));
});
