import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { configuration } from '../lib/config.mjs';
import { ContentStore } from '../lib/content-store.mjs';

const scratch=path.resolve('../../work/tests');
async function root(t){await fs.mkdir(scratch,{recursive:true});const directory=await fs.mkdtemp(path.join(scratch,'content-http-'));t.after(async()=>{assert.ok(directory.startsWith(scratch+path.sep));await fs.rm(directory,{recursive:true,force:true});});return directory;}
test('test style edits survive restart without altering real preferences or account positioning',async t=>{
 const directory=await root(t),store=new ContentStore(directory);await store.initialize();const account=store.defaultAccount(),real=structuredClone(store.snapshot().styles);
 const changed=await store.styleUpdate(account.id,{requestId:randomUUID(),isTest:true,confirmPermanent:true,rules:['TEST: technische Vorgabe'],provisionalPreset:'TEST'});
 assert.equal(changed.isTest,true);assert.deepEqual(store.snapshot().styles,real);assert.equal(store.brief(account.id,{isTest:true}).style.id,changed.id);
 await assert.rejects(()=>store.accountUpdate(account.id,{isTest:true,positioning:'TEST darf reale Positionierung nicht ändern'}));
 const restarted=new ContentStore(directory);await restarted.initialize();assert.deepEqual(restarted.snapshot().styles,real);assert.equal(restarted.snapshot({test:true}).styles.at(-1).id,changed.id);assert.equal(restarted.defaultAccount().positioning,'');
});
test('content routes and evidence stay private; byte checksums and test scopes are correct',async t=>{
 const directory=await root(t),password='ONLY-LOCAL-CONTENT-CONTRACT-TEST',studio=await createStudio(configuration({DATA_DIR:directory,STUDIO_PASSWORD:password}),{scheduler:false,statfs:async()=>({blocks:2**30,bavail:2**29,bsize:4096})});
 const server=studio.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{await studio.close();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`,auth='Basic '+Buffer.from('hec:'+password).toString('base64'),headers={authorization:auth,'x-reel-studio':'1','content-type':'application/json'};
 for(const endpoint of ['/api/content','/api/content/knowledge','/api/content/meta/status','/api/content/import-template.csv'])assert.equal((await fetch(base+endpoint)).status,401);
 assert.equal((await fetch(base+'/api/content/run',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/content/run',{method:'POST',headers:{...headers,origin:'https://unrelated.invalid'},body:'{}'})).status,403);
 const evidence=Buffer.from('%PDF-1.4\nTEST-ONLY-BYTE-CHECKSUM\n%%EOF'),binaryHeaders={authorization:auth,'x-reel-studio':'1','content-type':'application/octet-stream','x-evidence-name':'TEST.pdf'};
 const first=await(await fetch(base+'/api/content/evidence?test=true',{method:'POST',headers:binaryHeaders,body:evidence})).json(),second=await(await fetch(base+'/api/content/evidence?test=true',{method:'POST',headers:binaryHeaders,body:evidence})).json();
 assert.equal(first.id,second.id);assert.equal(first.sha256,createHash('sha256').update(evidence).digest('hex'));
 assert.equal((await fetch(base+first.url)).status,401);const download=await fetch(base+first.url,{headers});assert.deepEqual(Buffer.from(await download.arrayBuffer()),evidence);
 assert.equal((await fetch(base+'/api/content/evidence/../../meta-private/key',{headers})).status,404);
 const real=await(await fetch(base+'/api/content',{headers})).json(),testing=await(await fetch(base+'/api/content?test=true',{headers})).json();assert.equal(real.evidence.length,0);assert.equal(testing.evidence.length,1);
 const wrongScope=await fetch(base+'/api/content/measurements',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),accountHandle:'adrien.e39',permalink:'https://www.instagram.com/reel/HEC_HTTP_TEST/',publishedAt:'2026-10-01T20:00:00Z',measuredAt:'2026-10-02T20:00:00Z',source:'TEST',metrics:{views:0},evidenceIds:[first.id]})});assert.equal(wrongScope.status,400);assert.equal(studio.contentService.content.state.measurements.length,0);
 const declined=await fetch(base+'/oauth/meta/callback?state=unbound&code=TEST',{redirect:'manual'});assert.equal(declined.status,403);
});
