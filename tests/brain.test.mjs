import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MediaLibrary } from '../lib/library.mjs';
import { JobStore } from '../lib/store.mjs';
import { CodexBrain } from '../lib/codex-brain.mjs';
import { SerialMedia } from '../lib/serial-media.mjs';
import { configuration } from '../lib/config.mjs';
import { ContentService } from '../lib/content-service.mjs';

const scratch=path.resolve('..','..','work','tests');await fs.mkdir(scratch,{recursive:true});
const review=()=>({catalog:{title:'Technisches Testbild',category:'unsortiert',tags:['Testmaterial'],description:'Eine erzeugte Farbtafel.',moments:[]},
  assessment:{use:'unsuitable',reason:'Keine echte HEC-Szene zu sehen.',nextStep:'Echte Aufnahmen hinzufügen.'},ideas:[],limitations:['Nur vorbereitete Testbilder.']});
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(scratch,'brain-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const library=new MediaLibrary(dir);await library.initialize();const store=new JobStore(dir);await store.initialize();
  const source=path.join(dir,'fixture.mp4');await fs.writeFile(source,'test');
  let {clip}=await library.adopt({id:randomUUID(),name:'fixture.mp4',path:source,size:4});
  clip=await library.update(clip.id,{duration:3,width:480,height:270,audio:false,status:'ready',previewReady:true});
  const config=configuration({DATA_DIR:dir,ANALYSIS_PROVIDER:'codex'});
  const evidence=async(asset,directory)=>{await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'sheet-001.jpg'),'fake-for-lease-contract-only');return {times:[0,1],sheets:['sheet-001.jpg'],transcript:{status:'no-audio',text:'',segments:[]},coverage:{type:'sampled-frames',frameCount:2}};};
  const brain=new CodexBrain(library,store,config,new SerialMedia(),{evidence});await brain.initialize();return {library,store,brain,clip,config,evidence};
}
test('Codex leases prevent parallel claims and stale writes; identical completion is safe to retry',async t=>{
  const {library,store,brain,clip,config,evidence}=await fixture(t);
  const request=await brain.prepareClip(clip);
  const claims=await Promise.allSettled([brain.claim(request.id,'worker-first'),brain.claim(request.id,'worker-second')]);
  assert.equal(claims.filter(value=>value.status==='fulfilled').length,1);
  const first=claims.find(value=>value.status==='fulfilled').value;
  assert.ok(!Object.hasOwn(brain.work()[0],'token'));
  const restarted=new CodexBrain(library,store,config,new SerialMedia(),{evidence});await restarted.initialize();
  assert.equal(restarted.work()[0].id,request.id);
  await restarted.save({...restarted.requests.get(request.id),leaseUntil:new Date(Date.now()-1000).toISOString()});
  const reclaimed=await restarted.claim(request.id,'worker-third');assert.notEqual(reclaimed.token,first.token);
  await assert.rejects(()=>restarted.complete(request.id,first.token,review()),error=>error.status===403);
  await library.edit(clip.id,{title:'Eigener Titel',tags:['Meine Tags']});
  assert.equal((await restarted.complete(request.id,reclaimed.token,review())).idempotent,false);
  assert.equal((await restarted.complete(request.id,reclaimed.token,review())).idempotent,true);
  const result=library.public(library.get(clip.id));assert.equal(result.title,'Eigener Titel');assert.deepEqual(result.tags,['Meine Tags']);
  assert.equal(result.classificationSource,'codex');assert.equal(result.brainReview.assessment.use,'unsuitable');
  assert.ok(!JSON.stringify(result).includes(reclaimed.token));
  await assert.rejects(()=>restarted.complete(request.id,reclaimed.token,{...review(),ideas:[{}]}),error=>error.status===409);
  assert.throws(()=>restarted.file(request.id,clip.id,'../../provider-settings.json'),error=>error.status===404);
});
test('detail-frame decode budget begins after a busy preview releases the media worker',async t=>{
  const {brain,clip}=await fixture(t);const request=await brain.prepareClip(clip),lease=await brain.claim(request.id,'frame-budget-worker');
  brain.frameTimeoutMs=10;let extracted=0;
  brain.frameExtractor=async(source,at,file,config,signal)=>{assert.equal(signal.aborted,false);extracted++;await fs.writeFile(file,'frame-test');};
  let release;const preview=brain.serial.run(()=>new Promise(resolve=>{release=resolve;}));
  const frame=brain.frame(request.id,lease.token,clip.id,1.75);
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(extracted,0);release();await preview;
  const output=await frame;assert.equal(output.at,1.75);assert.equal(extracted,1);assert.equal(brain.requests.get(request.id).details.length,1);
});
test('new previews give an active reel lease room for detail frames but never wait indefinitely for an offline worker',async t=>{
  const {brain}=await fixture(t),now=Date.now(),request={id:randomUUID(),kind:'job',status:'queued',createdAt:new Date(now).toISOString()};
  brain.requests.set(request.id,request);assert.equal(brain.previewPriorityWaiting(now+89_000),true);assert.equal(brain.previewPriorityWaiting(now+91_000),false);
  Object.assign(request,{status:'claimed',leaseUntil:new Date(now+120_000).toISOString()});assert.equal(brain.previewPriorityWaiting(now+100_000),true);assert.equal(brain.previewPriorityWaiting(now+121_000),false);
  request.status='done';assert.equal(brain.previewPriorityWaiting(now),false);request.status='error';assert.equal(brain.previewPriorityWaiting(now),false);
  request.status='queued';request.kind='clip';assert.equal(brain.previewPriorityWaiting(now),false);
});
test('Codex plans obey source bounds, cancellation, and single render handoff',async t=>{
  const {store,brain,clip}=await fixture(t);let handedOff=0;brain.onPlanReady=id=>{assert.equal([...brain.requests.values()].find(request=>request.kind==='job'&&request.targetId===id).status,'done');handedOff++;};
  const now=new Date().toISOString(),job=await store.create({id:randomUUID(),title:'Codex render contract',createdAt:now,status:'processing',assets:[clip],outputs:[],options:{mode:'codex',count:1,duration:15}});
  const request=await brain.prepareJob(job,[clip]);const claimed=await brain.claim(request.id,'worker-plan');
  const plan={summary:'Technical source only',reels:[{title:'Technical cut',hook:'Test',caption:'Technical test',hypothesis:'Verify rendering',segments:[{assetId:clip.id,from:0,duration:1,reason:'Visible test image'}]}]};
  const invalid=structuredClone(plan);invalid.reels[0].segments[0].from=4;
  await assert.rejects(()=>brain.complete(request.id,claimed.token,invalid),/außerhalb/);assert.equal(handedOff,0);
  await brain.complete(request.id,claimed.token,plan);await brain.complete(request.id,claimed.token,plan);assert.equal(handedOff,1);
  assert.equal(store.get(job.id).status,'queued');assert.equal(JSON.parse(await fs.readFile(path.join(store.directory(job.id),'outputs','plan.json'),'utf8')).provider,'codex');
  const second=await store.create({...job,id:randomUUID(),brainRequestId:null,status:'processing'});
  const pending=await brain.prepareJob(second,[clip]);const lease=await brain.claim(pending.id,'worker-cancel');
  await brain.cancel('job',second.id);await store.update(second.id,{status:'cancelled'});
  await assert.rejects(()=>brain.complete(pending.id,lease.token,plan),error=>error.status===409);assert.equal(handedOff,1);
  const third=await store.create({...job,id:randomUUID(),brainRequestId:null,status:'processing'});
  const refused=await brain.prepareJob(third,[clip]);const refusal=await brain.claim(refused.id,'worker-refuse');
  await brain.complete(refused.id,refusal.token,{decision:'no-reel',reason:'No real HEC scene in the technical fixture.'});
  assert.equal(store.get(third.id).status,'no-reel');assert.equal(handedOff,1);
});
test('managed plan requires the current briefing, recovers prepared inputs and acknowledges one render after restart',async t=>{
 const {library,store,brain,clip,config,evidence}=await fixture(t),queued=[],queue={enqueue:id=>queued.push(id)};
 const service=new ContentService(config,library,store,queue,brain);await service.initialize();brain.contentService=service;
 const version=await service.content.reserveDraft({requestId:randomUUID(),title:'TEST · managed cut',isTest:true,assetIds:[clip.id]},library.list());
 // Crash after preparing inputs but before creating the durable JobStore entry.
 const inputs=path.join(store.directory(version.jobId),'inputs');await fs.mkdir(inputs,{recursive:true});await fs.copyFile(clip.path,path.join(inputs,clip.id+clip.extension));
 await service.dispatch();assert.equal(store.list().length,1);await service.dispatch();assert.equal(store.list().length,1);
 const job=store.get(version.jobId);await store.update(job.id,{status:'processing'});const request=await brain.prepareJob(store.get(job.id),job.assets),lease=await brain.claim(request.id,'test-managed-worker');
 const raw={summary:'TEST · contract only',reels:[{title:'TEST',hook:'TEST movement',caption:'TEST only',hypothesis:'TEST briefing and receipt',segments:[{assetId:clip.id,from:0,duration:1,reason:'TEST fixture'}]}]};
 await assert.rejects(()=>brain.complete(request.id,lease.token,raw));
 raw.reels[0].features={topic:'Technical',opening:'Test image',action:'Test',cut:'One second',sound:'None',text:'TEST',expectedReaction:'Technical review'};
 raw.reels[0].briefingApplied=[{sourceId:version.briefing.style.id,change:'Only technical TEST fixture; personal preset is inapplicable.'}];
 let handoffs=0;brain.onPlanReady=()=>handoffs++;await brain.complete(request.id,lease.token,raw);await brain.complete(request.id,lease.token,raw);assert.equal(handoffs,1);
 const storedPlan=JSON.parse(await fs.readFile(path.join(store.directory(job.id),'outputs','plan.json'),'utf8'));assert.equal(storedPlan.reels[0].briefingApplied[0].sourceId,version.briefing.style.id);
 await brain.save({...brain.requests.get(request.id),status:'claimed',resultHash:null});
 const restarted=new CodexBrain(library,store,config,new SerialMedia(),{evidence});await restarted.initialize();restarted.contentService=service;restarted.onPlanReady=()=>handoffs++;
 assert.equal(restarted.requests.get(request.id).status,'done');assert.equal((await restarted.complete(request.id,lease.token,raw)).idempotent,true);assert.equal(handoffs,1);
});
