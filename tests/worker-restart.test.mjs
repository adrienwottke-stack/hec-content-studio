import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RenderQueue} from '../lib/queue.mjs';
import {LibraryQueue} from '../lib/library-queue.mjs';

async function blockedRender(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hec-restart-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const job={id:'existing-job',status:'queued',plan:{segments:[{from:2,duration:1}]}};
 const store={get:()=>job,directory:()=>root,update:async(id,patch)=>{assert.equal(id,job.id);Object.assign(job,patch);return job;}};
 let started;const ready=new Promise(resolve=>{started=resolve;});
 const serial={run:(task,signal)=>{started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}};
 const queue=new RenderQueue(store,{}, {serial});queue.enqueue(job.id);await ready;return {queue,job};
}
test('shutdown retains the same unfinished render and plan for startup recovery',async t=>{
 const {queue,job}=await blockedRender(t);await queue.close();
 assert.equal(job.status,'queued');assert.equal(job.error,null);assert.deepEqual(job.plan,{segments:[{from:2,duration:1}]});assert.equal(queue.running,null);
});
test('explicit user cancellation remains cancelled rather than automatically restarting',async t=>{
 const {queue,job}=await blockedRender(t);queue.cancel(job.id);
 while(queue.running)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(job.status,'cancelled');assert.equal(job.error,null);await queue.close();
});
test('shutdown preserves unfinished library originals and requeues previews and analysis',async()=>{
 for(const previewReady of [false,true]){
  const clip={id:'original-clip',status:'processing',previewReady,path:'/unchanged/original.mp4',sha256:'unchanged'};
  const library={get:()=>clip,update:async(id,patch)=>{assert.equal(id,clip.id);Object.assign(clip,patch);return clip;}};
  const queue=new LibraryQueue(library,{},null);let start;const ready=new Promise(resolve=>{start=resolve;});
  queue.process=async(id,signal)=>{start();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  queue.enqueue(clip.id);await ready;await queue.close();
  assert.equal(clip.status,'queued');assert.equal(clip.error,null);assert.equal(clip.analysisError,null);assert.equal(clip.path,'/unchanged/original.mp4');assert.equal(clip.sha256,'unchanged');
 }
});
