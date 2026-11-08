import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConfigStore, hashKey } from '../src/admin-store.mjs';
import { createMRExpiryCleaner } from '../src/key-expiry-cleaner.mjs';
import { createRouter } from '../src/router.mjs';
import { createAdmin } from '../src/admin.mjs';

const NOW=Date.parse('2030-01-01T00:00:00Z');
const past='2029-12-31T23:59:59Z',future='2031-01-01T00:00:00Z';
const group=(id,keys,apiKeys=[])=>({id,virtualApiKeys:keys,apiKeys,upstreamApiKey:'synthetic-provider',routes:{chat:{baseURL:'http://127.0.0.1:1/v1'}},models:[{id:'model'}]});
const meta=(key,expiresAt)=>({[hashKey(key)]:{label:'synthetic',expiresAt}});
async function fixture(t,groups,reload=async()=>{}){const dir=await mkdtemp(join(tmpdir(),'mr-cleanup-'));const path=join(dir,'config.json');await writeFile(path,JSON.stringify({host:'127.0.0.1',port:0,groups}),{mode:0o600});const store=new ConfigStore({configPath:path,backupDir:join(dir,'backups'),reload});return{dir,path,store,raw:async()=>JSON.parse(await readFile(path,'utf8'))};}

test('expiry removes only expired MR entries and metadata, preserves direct/future/unlimited keys and is idempotent',async t=>{
const g=group('mixed',['mr-expired','mr-future','mr-unlimited'],['synthetic-direct']);g.virtualKeyMeta={...meta('mr-expired',past),...meta('mr-future',future),...meta('mr-unlimited',null)};g.apiKeyMeta=meta('synthetic-direct',past);let reloads=0;const f=await fixture(t,[g],async()=>reloads++);
const result=await f.store.removeExpiredMRKeys(NOW);assert.equal(result.removed.length,1);assert.equal(reloads,1);assert.equal(f.store.revision,1);const raw=await f.raw();assert.deepEqual(raw.groups[0].virtualApiKeys,['mr-future','mr-unlimited']);assert.equal(raw.groups[0].virtualKeyMeta[hashKey('mr-expired')],undefined);assert.deepEqual(raw.groups[0].apiKeys,['synthetic-direct']);assert.ok(raw.groups[0].apiKeyMeta[hashKey('synthetic-direct')]);assert.equal(raw.groups[0].enabled,undefined);assert.equal((await readdir(join(f.dir,'backups'))).length,1);
const before=await readFile(f.path,'utf8');assert.equal((await f.store.removeExpiredMRKeys(NOW)).unchanged,true);assert.equal(await readFile(f.path,'utf8'),before);assert.equal(reloads,1);
});

test('last expired MR key is deleted while its empty group is disabled and remains editable',async t=>{
const g=group('last',['mr-last']);g.virtualKeyMeta=meta('mr-last',past);const f=await fixture(t,[g]);await f.store.removeExpiredMRKeys(NOW);const raw=await f.raw();assert.equal(raw.groups.length,1);assert.deepEqual(raw.groups[0].virtualApiKeys,[]);assert.equal(raw.groups[0].virtualKeyMeta,undefined);assert.equal(raw.groups[0].enabled,false);assert.deepEqual(raw.groups[0].models,g.models);assert.deepEqual(raw.groups[0].routes,g.routes);const router=createRouter(raw);router.close();
await f.store.update(config=>{config.groups[0].virtualApiKeys.push('mr-replacement');config.groups[0].enabled=true;});assert.equal((await f.raw()).groups[0].enabled,true);
});

test('environment-backed MR references are deleted without deleting environment or direct credentials',async t=>{
const name='MR_SYNTHETIC_CLEANUP';process.env[name]='mr-env-expired';t.after(()=>delete process.env[name]);const g=group('env',[{env:name}],['synthetic-direct']);g.virtualKeyMeta=meta('mr-env-expired',past);const f=await fixture(t,[g]);await f.store.removeExpiredMRKeys(NOW);assert.deepEqual((await f.raw()).groups[0].virtualApiKeys,[]);assert.equal(process.env[name],'mr-env-expired');
});

test('serialized renewal before a sweep is not lost to a stale expiry snapshot',async t=>{
const g=group('renew',['mr-renew']);g.virtualKeyMeta=meta('mr-renew',past);const f=await fixture(t,[g]);let unblock;const waiting=new Promise(resolve=>{unblock=resolve});const renew=f.store.update(async raw=>{await waiting;raw.groups[0].virtualKeyMeta[hashKey('mr-renew')].expiresAt=future;});const sweep=f.store.removeExpiredMRKeys(NOW);unblock();await renew;assert.equal((await sweep).removed.length,0);assert.deepEqual((await f.raw()).groups[0].virtualApiKeys,['mr-renew']);
});

test('failed reload rolls back deletion and a later cleanup retries successfully',async t=>{
const g=group('retry',['mr-retry']);g.virtualKeyMeta=meta('mr-retry',past);let fail=true;const f=await fixture(t,[g],async()=>{if(fail){fail=false;throw new Error('synthetic reload failure')}});const before=await readFile(f.path,'utf8');await assert.rejects(()=>f.store.removeExpiredMRKeys(NOW),/回滚/);assert.deepEqual((await f.raw()).groups[0].virtualApiKeys,['mr-retry']);assert.equal(f.store.revision,0);assert.equal((await f.store.removeExpiredMRKeys(NOW)).removed.length,1);assert.equal(f.store.revision,1);
});

test('cleaner shares pending work and close prevents subsequent runs',async()=>{
let calls=0,release;const barrier=new Promise(resolve=>{release=resolve});let notified=0;const cleaner=createMRExpiryCleaner({async removeExpiredMRKeys(){calls++;await barrier;return{removed:[{group:'g',keyId:'synthetic'}]}}},{intervalMs:100000,now:()=>NOW,onRemoved:()=>notified++});const a=cleaner.run(),b=cleaner.run();assert.equal(a,b);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();await a;assert.equal(notified,1);await cleaner.close();assert.deepEqual(await cleaner.run(),{removed:[]});assert.equal(calls,1);
});

test('shared management store exposes cleanup revisions and no longer lists deleted MR keys',async t=>{
const g=group('ui',['mr-ui-expired'],['synthetic-direct']);g.virtualKeyMeta=meta('mr-ui-expired',past);const f=await fixture(t,[g]);const admin=await createAdmin({store:f.store,configPath:f.path,runDir:join(f.dir,'run'),projectRoot:f.dir,adminPort:0});await new Promise(resolve=>admin.listen(0,'127.0.0.1',resolve));t.after(async()=>{admin.closeAllConnections();await new Promise(resolve=>admin.close(resolve))});const base='http://127.0.0.1:'+admin.address().port;const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-ui-expiry-password'})});assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];const state=async()=>{const response=await fetch(base+'/api/state',{headers:{cookie}});assert.equal(response.status,200);return response.json()};assert.equal((await state()).groups[0].virtualKeys.length,1);await f.store.removeExpiredMRKeys(NOW);const after=await state();assert.equal(after.groups[0].virtualKeys.length,0);assert.equal(after.configRevision,1);assert.equal((await (await fetch(base+'/api/stats',{headers:{cookie}})).json()).configRevision,1);
});

test('actual no-admin server schedules persistent MR deletion without touching its remaining direct key',async t=>{
const dir=await mkdtemp(join(tmpdir(),'mr-cleanup-server-'));const path=join(dir,'config.json');const g=group('background',['mr-background'],['synthetic-direct']);g.virtualKeyMeta=meta('mr-background',new Date(Date.now()+1500).toISOString());await writeFile(path,JSON.stringify({host:'127.0.0.1',port:0,groups:[g]}),{mode:0o600});await cp(resolve('src'),join(dir,'src'),{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({type:'module',version:'test'}));const child=spawn(process.execPath,[join(dir,'src/server.mjs'),'--config',path,'--no-admin'],{cwd:dir,stdio:['ignore','pipe','pipe']});let output='',errors='';child.stderr.on('data',chunk=>errors+=chunk);let resolveRemoved,rejectRemoved;const removed=new Promise((resolve,reject)=>{resolveRemoved=resolve;rejectRemoved=reject});const timer=setTimeout(()=>rejectRemoved(new Error('cleanup not observed: '+output+' '+errors)),7000);t.after(async()=>{clearTimeout(timer);if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}});child.stdout.on('data',chunk=>{output+=chunk;for(const line of output.split(String.fromCharCode(10))){try{if(JSON.parse(line).event==='mr_keys_expired')resolveRemoved()}catch{}}});child.once('error',rejectRemoved);await removed;const raw=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(raw.groups[0].virtualApiKeys,[]);assert.deepEqual(raw.groups[0].apiKeys,['synthetic-direct']);assert.equal(raw.groups[0].enabled,undefined);assert.equal((await readdir(join(dir,'run','backups'))).length,1);
});
