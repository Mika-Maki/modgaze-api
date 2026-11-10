// Synthetic loopback-only probe; no live configuration or upstream access.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAdmin } from '../src/admin.mjs';
import { ConfigStore } from '../src/admin-store.mjs';
import { AdminAuth } from '../src/admin-auth.mjs';
const root = await mkdtemp(join(tmpdir(), 'amerge-admission-audit-'));
let admin;
try {
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({rateLimits:{admin:{rpm:1}}, groups:[{id:'synthetic',apiKeys:['synthetic-key'],routes:{chat:{baseURL:'http://127.0.0.1:1'}},models:[{id:'synthetic-model'}]}]}), {mode:0o600});
  await new AdminAuth(join(root, 'admin-auth.private.json')).setPassword('Synthetic-audit-password-12345');
  const store = new ConfigStore({configPath,backupDir:join(root,'backups'),reload:async()=>{}});
  const original = store.read.bind(store); let reads=0;
  store.read=async()=>{reads++; return original();};
  admin=await createAdmin({configPath,runDir:join(root,'run'),store,adminPort:0});
  await new Promise(resolve=>admin.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+admin.address().port+'/api/state';
  const statuses=[]; const baseline=reads;
  for(let i=0;i<4;i++) {
    const {stdout}=await promisify(execFile)('curl',['--noproxy','*','-sS','--max-time','5','-o','/dev/null','-w','%{http_code}',url]);
    statuses.push(Number(stdout));
    console.log(JSON.stringify({curl:'curl --noproxy "*" -sS --max-time 5 -o /dev/null -w "%{http_code}" '+url,curlExit:0,status:Number(stdout),configReads:reads-baseline}));
  }
  assert.deepEqual(statuses,[401,429,429,429]); assert.equal(reads-baseline,0);
  console.log('VERIFIED: unauthenticated and rejected requests perform zero configuration reads; no load test performed');
} finally {
  if(admin){admin.closeAllConnections();await new Promise(resolve=>admin.close(resolve));}
  assert.ok(root.startsWith(join(tmpdir(),'amerge-admission-audit-')));
  await rm(root,{recursive:true,force:true});
}
