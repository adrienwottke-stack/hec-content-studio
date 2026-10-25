import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { MediaLibrary } from '../lib/library.mjs';
import { JobStore } from '../lib/store.mjs';
import { PhotoStore } from '../lib/photo-store.mjs';
import { PhotoQueue } from '../lib/photo-queue.mjs';
import { CodexBrain } from '../lib/codex-brain.mjs';
import { SerialMedia } from '../lib/serial-media.mjs';
import { configuration } from '../lib/config.mjs';
import { validatePhotoReview,photoHash } from '../lib/photo-review.mjs';
import { photoMetadata,extractPhotoPreview,exportPhotoNative,photoSampleTimes } from '../lib/photo-media.mjs';
import { writePhotoZip,verifyPhotoZip } from '../lib/photo-zip.mjs';
import { createStudio } from '../server.mjs';
import { run } from '../lib/process.mjs';

const scratch=path.resolve('..','..','work','tests');await fs.mkdir(scratch,{recursive:true});
async function directory(t){const dir=await fs.mkdtemp(path.join(scratch,'photos-'));t.after(async()=>{assert.equal(path.dirname(dir),scratch);await fs.rm(dir,{recursive:true,force:true});});return dir;}
async function fixture(t){
  const dir=await directory(t),library=new MediaLibrary(dir);await library.initialize();const store=new JobStore(dir);await store.initialize();
  const source=path.join(dir,'source.mp4');await fs.writeFile(source,'contract-source');let {clip}=await library.adopt({id:randomUUID(),name:'source.mp4',path:source,size:15});
  clip=await library.update(clip.id,{duration:4,width:480,height:640,status:'ready',previewReady:true});
  const config=configuration({DATA_DIR:dir,ANALYSIS_PROVIDER:'codex'}),photos=new PhotoStore(dir,library,config);await photos.initialize();
  const raw={requestId:randomUUID(),assetIds:[clip.id],subjectReference:{assetId:clip.id,at:0.8},presetId:'presence',maxFavorites:2},session=await photos.create(raw);
  const brain=new CodexBrain(library,store,config,new SerialMedia(),{photos});await brain.initialize();return {dir,library,store,clip,config,photos,raw,session,brain};
}
async function prepared(f) {
  await f.photos.mutate(f.session.id,session=>{session.assets[0].fps=25;session.assets[0].streamIndex=0;session.status='preparing';});
  for(const at of [0.72,0.8,0.88,1.52,1.6,1.68,2.32,2.4,2.48]) {
    const id=photoHash([f.clip.id,at]).slice(0,32),frame={id,assetId:f.clip.id,at,requestedAt:at,pts:String(at*25000),timeBase:'1/25000',decoderChecksum:id.slice(0,8),filename:`frame-${id}.jpg`};await f.photos.addFrame(f.session.id,f.clip.id,frame,at);
  }
  await f.photos.mutate(f.session.id,session=>{const evidence=session.evidence[f.clip.id];evidence.overview=Object.keys(evidence.frames);session.referenceFrame=evidence.frames[evidence.byTime['0.8']];});
  const request=await f.brain.preparePhoto(f.photos.get(f.session.id)),lease=await f.brain.claim(request.id,'photo-contract-worker');
  const windows=[];
  for(const from of [0.72,1.52,2.32]) {
    const window=await f.photos.requestWindow(f.session.id,{assetId:f.clip.id,from,to:from+0.16,step:0.08});windows.push(window.id);
    await f.photos.mutate(f.session.id,session=>{const item=session.windows[window.id];item.status='done';item.frameIds=item.times.map(at=>session.evidence[f.clip.id].byTime[String(at)]);item.processed=item.times.length;});
  }
  return {request,lease,windows};
}
const result=(f,windows,at=0.8,group='clear-gaze')=>({summary:'Synthetic contract test; no editorial quality claim.',subjectStatus:'confirmed',sourceReviews:[{assetId:f.clip.id,decision:'reviewed',reason:'Contract fixture only.'}],reviewedWindowIds:windows,
  candidates:[{assetId:f.clip.id,at,rank:1,group,tier:'favorite',reason:'Technical selection contract.',limitations:['Synthetic test fixture.']}],rejections:[],limitations:['Contract simulation.']});

test('photo creation is concurrent-safe, persists its receipt and uses existing originals',async t=>{
  const f=await fixture(t),arrivals=await Promise.all([f.photos.create(f.raw),f.photos.create({...f.raw})]);assert.equal(arrivals[0].id,arrivals[1].id);assert.equal(f.photos.list().length,1);
  assert.equal(await fs.readFile(f.clip.path,'utf8'),'contract-source');
  const restarted=new PhotoStore(f.dir,f.library,f.config);await restarted.initialize();assert.equal((await restarted.create(f.raw)).id,f.session.id);
  await assert.rejects(()=>restarted.create({...f.raw,maxFavorites:3}),error=>error.status===409);
  await assert.rejects(()=>restarted.create({...f.raw,requestId:randomUUID(),subjectReference:{assetId:randomUUID(),at:1}}),/Referenzbild/);
  await assert.rejects(()=>restarted.create({...f.raw,requestId:randomUUID(),filter:'arbitrary-command'}),/unbekannte/);
});
test('photo review requires every source and dense neighbors; rejects injection, bounds and repeated motives',async t=>{
  const f=await fixture(t),{windows}=await prepared(f),base=result(f,windows),session=f.photos.get(f.session.id);
  assert.equal(validatePhotoReview(base,session).candidates.length,1);
  for(const change of [{sourceReviews:[]},{reviewedWindowIds:[]},{subjectStatus:'unclear'},{candidates:[{...base.candidates[0],assetId:randomUUID()}]},{candidates:[{...base.candidates[0],at:8}]},{candidates:[{...base.candidates[0],file:'/etc/passwd'}]}])assert.throws(()=>validatePhotoReview({...base,...change},session));
  assert.throws(()=>validatePhotoReview({...base,candidates:[base.candidates[0],{...base.candidates[0],at:1.6,rank:2}]},session),/Motivgruppe/);
  assert.equal(validatePhotoReview({...base,candidates:[base.candidates[0],{...base.candidates[0],at:1.6,rank:2,tier:'variant'}]},session).candidates.length,2);
  const empty=validatePhotoReview({...base,subjectStatus:'unclear',candidates:[]},session);assert.equal(empty.candidates.length,0);
});
test('photo result acknowledgement is idempotent; more keeps favorites and exclusions after restart',async t=>{
  const f=await fixture(t),{request,lease,windows}=await prepared(f),base=result(f,windows);let handoffs=0;f.brain.onPhotoReady=()=>handoffs++;
  assert.equal((await f.brain.complete(request.id,lease.token,base)).idempotent,false);assert.equal((await f.brain.complete(request.id,lease.token,base)).idempotent,true);assert.equal(handoffs,1);
  await assert.rejects(()=>f.brain.complete(request.id,lease.token,{...base,summary:'Different result'}),error=>error.status===409);
  const selected=f.photos.get(f.session.id).candidates[0],selectionId=randomUUID();await f.photos.selection(f.session.id,{requestId:selectionId,frameId:selected.frameId,action:'reject'});
  const version=f.photos.get(f.session.id).selectionVersion;await f.photos.selection(f.session.id,{requestId:selectionId,frameId:selected.frameId,action:'reject'});assert.equal(f.photos.get(f.session.id).selectionVersion,version);
  await f.photos.selection(f.session.id,{requestId:randomUUID(),frameId:selected.frameId,action:'favorite'});await f.photos.update(f.session.id,{status:'ready'});
  const continuation={requestId:randomUUID(),note:'Additional distinct motive'};await Promise.all([f.photos.more(f.session.id,continuation),f.photos.more(f.session.id,continuation)]);assert.equal(f.photos.get(f.session.id).round,2);
  assert.equal(f.photos.get(f.session.id).candidates[0].favorite,true);assert.throws(()=>validatePhotoReview(base,f.photos.get(f.session.id)),/bereits/);
  assert.throws(()=>validatePhotoReview(result(f,windows,1.6,'clear-gaze'),f.photos.get(f.session.id)),/Motivgruppe/);
  assert.equal(validatePhotoReview(result(f,windows,1.6,'different-gesture'),f.photos.get(f.session.id)).candidates.length,1);
  const restarted=new PhotoStore(f.dir,f.library,f.config);await restarted.initialize();assert.equal(restarted.get(f.session.id).round,2);assert.equal(restarted.get(f.session.id).candidates[0].frameId,selected.frameId);
});
test('photo cancellation blocks stale agents; interrupted detail windows and exports resume with cached frames',async t=>{
  const f=await fixture(t),{request,lease,windows}=await prepared(f);await f.photos.cancel(f.session.id);await f.brain.cancel('photo',f.session.id);
  await assert.rejects(()=>f.brain.complete(request.id,lease.token,result(f,windows)),error=>error.status===409);
  assert.equal(f.photos.get(f.session.id).candidates.length,0);
  await f.photos.retry(f.session.id);assert.equal(f.photos.get(f.session.id).status,'queued');
  const cached=Object.keys(f.photos.get(f.session.id).evidence[f.clip.id].frames).length;
  await f.photos.mutate(f.session.id,session=>{session.status='exporting';session.windows[windows[0]].status='running';});
  const restarted=new PhotoStore(f.dir,f.library,f.config);await restarted.initialize();assert.equal(restarted.get(f.session.id).status,'export-queued');assert.equal(restarted.get(f.session.id).windows[windows[0]].status,'queued');assert.equal(Object.keys(restarted.get(f.session.id).evidence[f.clip.id].frames).length,cached);
});
test('photo windows cache duplicate requests and bound the detail budget',async t=>{
  const f=await fixture(t);await f.photos.update(f.session.id,{status:'waiting-codex'});
  const raw={assetId:f.clip.id,from:0.4,to:1.2,step:0.04},[a,b]=await Promise.all([f.photos.requestWindow(f.session.id,raw),f.photos.requestWindow(f.session.id,raw)]);assert.equal(a.id,b.id);assert.equal(Object.keys(f.photos.get(f.session.id).windows).length,1);
  await assert.rejects(()=>f.photos.requestWindow(f.session.id,{...raw,step:0.001}),/Abstand/);await assert.rejects(()=>f.photos.requestWindow(f.session.id,{...raw,assetId:randomUUID()}),/nicht verfügbar/);
  await assert.rejects(()=>f.photos.requestWindow(f.session.id,{...raw,from:0,to:3.99,step:0.02}),/Maximal/);
  assert.throws(()=>f.photos.evidenceFile(f.session.id,f.clip.id,'../../session.json'),error=>error.status===404);assert.throws(()=>f.photos.exportFile(f.session.id,'session.json'),error=>error.status===404);
});
test('a persisted photo completion recovers an unconfirmed brain acknowledgement without a second round',async t=>{
  const f=await fixture(t),{request,lease,windows}=await prepared(f),base=result(f,windows);
  await f.photos.completeReview(f.session.id,request.id,1,base);
  const restarted=new CodexBrain(f.library,f.store,f.config,new SerialMedia(),{photos:f.photos});await restarted.initialize();
  assert.equal((await restarted.complete(request.id,lease.token,base)).idempotent,true);assert.equal(f.photos.get(f.session.id).candidates.length,1);assert.equal(restarted.work().length,0);
});
test('photo routes and evidence downloads use the existing private auth and origin checks',async t=>{
  const dir=await directory(t),config=configuration({DATA_DIR:dir,ANALYSIS_PROVIDER:'codex',STUDIO_PASSWORD:'private-photo-contract'}),studio=await createStudio(config);
  const server=studio.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(async()=>{await studio.close();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Basic '+Buffer.from('hec:private-photo-contract').toString('base64'),'x-reel-studio':'1','Content-Type':'application/json'};
  for(const endpoint of ['/api/photos','/api/photos/config',`/api/photos/${randomUUID()}/files/foto.jpg`])assert.equal((await fetch(base+endpoint)).status,401);
  assert.equal((await fetch(base+'/api/photos/config',{headers})).status,200);
  assert.equal((await fetch(base+'/api/photos/from-library',{method:'POST',headers:{...headers,origin:'https://other.invalid'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/photos/from-library',{method:'POST',headers,body:'{}'})).status,400);
});
test('native photo export preserves portrait dimensions and actual PTS; ZIP verifies every JPEG',async t=>{
  const dir=await directory(t),config=configuration({DATA_DIR:dir}),source=path.join(dir,'portrait.mp4');
  await run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=120x216:rate=25','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',source]);
  const asset={id:randomUUID(),path:source,sha256:createHash('sha256').update(await fs.readFile(source)).digest('hex'),...await photoMetadata({path:source},config)},framesDir=path.join(dir,'frames'),output=path.join(dir,'native.jpg');
  const frame=await extractPhotoPreview(asset,0.32,framesDir,config),exported=await exportPhotoNative(asset,frame,output,config);assert.equal(exported.width,120);assert.equal(exported.height,216);assert.equal(exported.at,0.32);assert.equal(exported.pts,frame.pts);assert.ok(exported.bytes>1000);
  const name=`foto-${frame.id}.jpg`,zip=path.join(dir,'photos.zip'),entries=[{name,path:output}];await writePhotoZip(zip,entries);await verifyPhotoZip(zip,entries);
  const corrupt=await fs.readFile(zip);corrupt[30+name.length+50]^=1;await fs.writeFile(zip,corrupt);await assert.rejects(()=>verifyPhotoZip(zip,entries),/prüfsumme/);
  assert.ok(photoSampleTimes(335.52,1).length>32);assert.ok(photoSampleTimes(335.52,15).length<=48);
});

test('real serial photo workflow prepares, refines, exports and extends the same session without repeating originals',async t=>{
  const f=await fixture(t),source=path.join(f.dir,'real.mp4');
  await run(f.config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=120x216:rate=25','-t','4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',source]);
  await f.library.update(f.clip.id,{path:source,sha256:createHash('sha256').update(await fs.readFile(source)).digest('hex')});
  await f.photos.mutate(f.session.id,session=>{session.assets[0].sha256=f.library.get(f.clip.id).sha256;});
  const serial=new SerialMedia(),queue=new PhotoQueue(f.photos,f.library,f.config,serial,{brain:f.brain});f.brain.photoQueue=queue;f.brain.onPhotoReady=id=>queue.enqueue(id);t.after(()=>queue.close());
  const wait=async condition=>{const until=Date.now()+25_000;while(!condition()){if(Date.now()>until)throw new Error('Real photo workflow timed out');await new Promise(resolve=>setTimeout(resolve,25));}};
  queue.enqueue(f.session.id);await wait(()=>f.photos.get(f.session.id).status==='waiting-codex');
  let session=f.photos.get(f.session.id);assert.ok(session.referenceFrame);assert.equal(session.assets[0].width,120);assert.ok(f.brain.manifest(f.brain.requests.get(session.brainRequestId)).subjectReference.fileUrl);
  let lease=await f.brain.claim(session.brainRequestId,'real-photo-worker');let window=await queue.requestWindow(session.id,{assetId:f.clip.id,from:0.72,to:0.88,step:0.04});
  await wait(()=>f.photos.get(session.id).windows[window.id].status==='done');await f.brain.complete(session.brainRequestId,lease.token,result(f,[window.id]));await wait(()=>f.photos.get(session.id).status==='ready');
  session=f.photos.get(session.id);const first=session.candidates[0];assert.equal(first.output.width,120);assert.equal(first.output.height,216);assert.equal(session.exports[0].count,1);assert.equal(session.exports[0].frameIds[0],first.frameId);
  const before=Object.keys(session.evidence[f.clip.id].frames).length,more={requestId:randomUUID(),note:'New motive'};await f.photos.more(session.id,more);queue.enqueue(session.id);await wait(()=>f.photos.get(session.id).status==='waiting-codex');
  session=f.photos.get(session.id);assert.equal(Object.keys(session.evidence[f.clip.id].frames).length,before);lease=await f.brain.claim(session.brainRequestId,'real-photo-worker');window=await queue.requestWindow(session.id,{assetId:f.clip.id,from:2.32,to:2.48,step:0.04});
  await wait(()=>f.photos.get(session.id).windows[window.id].status==='done');await f.brain.complete(session.brainRequestId,lease.token,result(f,[window.id],2.4,'second-motive'));await wait(()=>f.photos.get(session.id).status==='ready');
  session=f.photos.get(session.id);assert.equal(session.candidates.length,2);assert.equal(session.candidates[0].frameId,first.frameId);assert.equal(session.exports.at(-1).count,2);assert.equal(session.round,2);
  assert.ok(!JSON.stringify(f.photos.public(session)).includes(source));assert.ok(!JSON.stringify(f.photos.public(session)).includes(lease.token));
  await f.photos.more(session.id,more);assert.equal(f.photos.get(session.id).round,2);assert.equal(f.photos.get(session.id).status,'ready');
});

test('rotation and variable frame rates use decoded frame identity rather than an assumed 25 fps',async t=>{
  const dir=await directory(t),config=configuration({DATA_DIR:dir}),source=path.join(dir,'vfr.mp4'),rotated=path.join(dir,'rotated.mp4');
  await run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=120x216:rate=25','-t','2','-vf',"select='not(mod(n,3))'",'-fps_mode','vfr','-c:v','libx264','-threads','1',source]);
  // Set the MP4 track display matrix directly in this isolated fixture. Recent
  // FFmpeg builds differ in whether a rotate metadata tag creates that matrix.
  const container=await fs.readFile(source),track=container.indexOf(Buffer.from('tkhd'));assert.ok(track>4);
  const matrix=track+(container[track+4]===1?56:44),values=[0,65536,0,-65536,0,0,0,0,1073741824];
  values.forEach((value,index)=>container.writeInt32BE(value,matrix+index*4));await fs.writeFile(rotated,container);
  const metadata=await photoMetadata({path:rotated},config);assert.equal(metadata.width,216);assert.equal(metadata.height,120);
  const asset={id:randomUUID(),path:rotated,sha256:createHash('sha256').update(await fs.readFile(rotated)).digest('hex'),...metadata},frame=await extractPhotoPreview(asset,0.13,path.join(dir,'frames'),config),output=await exportPhotoNative(asset,frame,path.join(dir,'native.jpg'),config);
  assert.equal(frame.at,0.24);assert.equal(output.at,frame.at);assert.equal(output.width,216);assert.equal(output.height,120);assert.equal(output.pts,frame.pts);
});
