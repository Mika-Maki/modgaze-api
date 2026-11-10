import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeMRExpiresAt } from '../src/key-expiry.mjs';
import { createRouter, compileConfig } from '../src/router.mjs';
import { createAdmin } from '../src/admin.mjs';
import { validateConfig } from '../src/config.mjs';
import { hashKey, sanitizeGroup } from '../src/admin-store.mjs';
const MR = 'mr-expiry-synthetic-key';
const DIRECT = 'sk-expiry-synthetic-direct';
const makeConfig = () => ({ host:'127.0.0.1',port:0,groups:[{id:'expiry',virtualApiKeys:[MR],apiKeys:[DIRECT],upstreamApiKey:'synthetic-upstream-secret',routes:{chat:{baseURL:'http://127.0.0.1:1/v1'}},models:[{id:'model'}]}] });
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});return 'http://127.0.0.1:'+server.address().port;}
async function stop(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const request = (base,key,headers={}) => fetch(base+'/v1/models',{headers:{...(key?{authorization:'Bearer '+key}:{}),...headers}});

test('MR expiry accepts absolute timestamps and rejects ambiguous/invalid dates',()=>{
assert.equal(normalizeMRExpiresAt(null),null);assert.equal(normalizeMRExpiresAt(''),null);
assert.equal(normalizeMRExpiresAt('2030-01-02T10:20:30+08:00'),'2030-01-02T02:20:30.000Z');
assert.equal(normalizeMRExpiresAt('2032-02-29T00:00:00Z'),'2032-02-29T00:00:00.000Z');
for(const input of ['2030-01-02T10:20','2030-01-02T10:20:30','2030-02-30T00:00:00Z','2031-02-29T00:00:00Z','2030-13-01T00:00:00Z','2030-01-01T24:00:00Z','tomorrow',0,false,{}])assert.throws(()=>normalizeMRExpiresAt(input),/Invalid MR Expires at/);
});

test('MR deadline is checked on each request, while direct keys and other MR keys are unaffected',async t=>{
const originalNow=Date.now;let now=Date.parse('2030-01-01T00:00:00Z');Date.now=()=>now;t.after(()=>{Date.now=originalNow;});
const config=makeConfig();config.groups[0].virtualApiKeys.push('mr-never-expires');config.groups[0].virtualKeyMeta={[hashKey(MR)]:{expiresAt:'2030-01-01T00:01:00Z'}};config.groups[0].apiKeyMeta={[hashKey(DIRECT)]:{expiresAt:'2000-01-01T00:00:00Z'}};
const router=createRouter(config);t.after(()=>stop(router));const base=await listen(router);
assert.equal((await request(base,MR)).status,200);now+=60000;
const expired=await request(base,MR);assert.equal(expired.status,401);assert.equal((await expired.json()).error.type,'authentication_error');
assert.equal((await request(base,null,{'x-api-key':MR})).status,401);
assert.equal((await request(base,DIRECT)).status,200);assert.equal((await request(base,'mr-never-expires')).status,200);
assert.equal((await fetch(base+'/healthz')).status,200);
config.groups[0].virtualKeyMeta[hashKey(MR)].expiresAt=null;router.reload(config);assert.equal((await request(base,MR)).status,200);
});

test('invalid imported MR deadlines fail closed; virtual env references resolve to the same key id',()=>{
const config=makeConfig();config.groups[0].virtualKeyMeta={[hashKey(MR)]:{expiresAt:'invalid'}};assert.throws(()=>compileConfig(config),/Invalid MR Expires at/);
config.groups[0].virtualKeyMeta[hashKey(MR)].expiresAt='2030-01-01T00:00:00Z';const resolved=compileConfig(config).config;
assert.equal(resolved.groups[0].virtualKeyExpirations.get(createHash('sha256').update(MR).digest('hex')),Date.parse('2030-01-01T00:00:00Z'));
const rawGroup={...config.groups[0],virtualApiKeys:[{env:'SYNTHETIC_MR'}]};const group=sanitizeGroup(rawGroup,resolved.groups[0]);assert.equal(group.virtualKeys[0].expiresAt,'2030-01-01T00:00:00.000Z');assert.equal(Object.hasOwn(group.apiKeys[0],'expiresAt'),false);
});

test('environment-backed MR keys enforce metadata deadlines after secret resolution',async t=>{
const name='MR_EXPIRY_SYNTHETIC_ENV';process.env[name]=MR;t.after(()=>{delete process.env[name]});const raw=makeConfig();raw.groups[0].virtualApiKeys=[{env:name}];raw.groups[0].virtualKeyMeta={[hashKey(MR)]:{expiresAt:'2000-01-01T00:00:00Z'}};const {resolved}=validateConfig(raw);const router=createRouter(resolved);t.after(()=>stop(router));const base=await listen(router);assert.equal((await request(base,MR)).status,401);assert.equal((await request(base,DIRECT)).status,200);
});

test('management edits MR expiry, persists and hot-reloads it; label edits/rotation retain it and direct API rejects it',async t=>{
const dir=await mkdtemp(join(tmpdir(),'mr-expiry-e2e-'));const configPath=join(dir,'config.json');const config=makeConfig();const id=hashKey(MR);config.groups[0].virtualKeyMeta={[id]:{label:'keep-label',createdAt:'2026-01-01T00:00:00Z'}};await writeFile(configPath,JSON.stringify(config),{mode:0o600});
const router=createRouter(config);const api=await listen(router);const admin=await createAdmin({configPath,runDir:join(dir,'run'),projectRoot:dir,adminPort:0,reload:next=>router.reload(next)});const base=await listen(admin);t.after(async()=>{await stop(admin);await stop(router)});
const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-expiry-password'})});assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0],csrf=(await setup.json()).csrfToken;
const headers={'content-type':'application/json',cookie,'x-csrf-token':csrf};const patch=(path,body,method='PATCH')=>fetch(base+'/api/groups/expiry/'+path,{method,headers,body:JSON.stringify(body)});
const path='virtual-keys/'+id;let response=await patch(path,{expiresAt:'2000-01-01T00:00:00Z'});assert.equal(response.status,200);let key=(await response.json()).group.virtualKeys[0];assert.equal(key.label,'keep-label');assert.equal(key.expiresAt,'2000-01-01T00:00:00.000Z');assert.equal((await request(api,MR)).status,401);
response=await patch(path,{label:'renamed'});assert.equal(response.status,200);assert.equal((await response.json()).group.virtualKeys[0].expiresAt,key.expiresAt);
const before=await readFile(configPath,'utf8');assert.equal((await patch(path,{expiresAt:'bad'})).status,400);assert.equal(await readFile(configPath,'utf8'),before);assert.equal((await patch('api-keys/'+hashKey(DIRECT),{label:'direct',expiresAt:null})).status,400);assert.equal((await request(api,DIRECT)).status,200);
response=await patch(path,{expiresAt:'2099-01-02T10:00:00+08:00'});assert.equal(response.status,200);key=(await response.json()).group.virtualKeys[0];assert.equal(key.expiresAt,'2099-01-02T02:00:00.000Z');assert.equal((await request(api,MR)).status,200);
response=await patch(path+'/rotate',{},'POST');assert.equal(response.status,200);const rotated=await response.json();assert.equal(rotated.group.virtualKeys[0].expiresAt,key.expiresAt);assert.equal((await request(api,MR)).status,401);assert.equal((await request(api,rotated.key)).status,200);
const newId=hashKey(rotated.key);response=await patch('virtual-keys/'+newId,{expiresAt:null});assert.equal(response.status,200);assert.equal((await response.json()).group.virtualKeys[0].expiresAt,null);
const stored=JSON.parse(await readFile(configPath,'utf8'));assert.equal(stored.groups[0].virtualKeyMeta[newId].expiresAt,null);assert.equal(stored.groups[0].virtualKeyMeta[newId].label,'renamed');
});
