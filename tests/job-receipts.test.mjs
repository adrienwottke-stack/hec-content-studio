import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {configuration} from '../lib/config.mjs';
import {createStudio} from '../server.mjs';
const scratch=path.resolve('..','..','work','tests');await fs.mkdir(scratch,{recursive:true});
test('background Reel submission is private, concurrent-safe, durable and rejects conflicting receipts',async t=>{
  const dataDir=await fs.mkdtemp(path.join(scratch,'job-receipts-'));
  const config=configuration({DATA_DIR:dataDir,STUDIO_PASSWORD:'background-job-test-password',ANALYSIS_PROVIDER:'codex'});
  let studio,server;
  const start=async()=>{
    studio=await createStudio({...config});studio.queue.closing=true;studio.libraryQueue.closing=true;
    server=studio.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop=async()=>{await studio.close();await new Promise(resolve=>server.close(resolve));};
  t.after(async()=>{await stop();await fs.rm(dataDir,{recursive:true,force:true});});
  let base=await start();
  if(!(await (await fetch(base+'/api/health')).json()).engine){t.skip('FFmpeg unavailable');return;}
  const source=path.join(dataDir,'fixture.mp4');await fs.writeFile(source,'technical fixture original');
  const saved=await studio.library.adopt({id:randomUUID(),name:'fixture.mp4',path:source,size:26},{collection:'Technical fixtures'});
  await studio.library.update(saved.clip.id,{status:'ready',analysisStatus:'waiting-codex'});
  const headers={'x-reel-studio':'1','Content-Type':'application/json',authorization:'Basic '+Buffer.from('hec:background-job-test-password').toString('base64')};
  const input={requestId:randomUUID(),assetIds:[saved.clip.id],mode:'quick',title:'Technical receipt test'};
  const submit=(body,customHeaders=headers)=>fetch(base+'/api/jobs/from-library',{method:'POST',headers:customHeaders,body:JSON.stringify(body)});
  assert.equal((await submit(input,{'x-reel-studio':'1','Content-Type':'application/json'})).status,401);
  const responses=await Promise.all([submit(input),submit(input)]);
  const jobs=await Promise.all(responses.map(async response=>{assert.equal(response.status,202);return response.json();}));
  assert.equal(jobs[0].id,input.requestId);assert.equal(jobs[1].id,input.requestId);assert.equal(studio.store.list().length,1);
  assert.equal(Object.hasOwn(jobs[0],'requestHash'),false);
  assert.equal((await submit({...input,title:'Changed job'})).status,409);assert.equal(studio.store.get(input.requestId).title,input.title);
  assert.equal((await submit({...input,requestId:'../../untrusted'})).status,400);
  await stop();base=await start();
  const repeated=await submit(input);assert.equal(repeated.status,202);assert.equal((await repeated.json()).id,input.requestId);
  assert.equal(studio.store.list().length,1);assert.equal(await fs.readFile(studio.library.get(saved.clip.id).path,'utf8'),'technical fixture original');
});
