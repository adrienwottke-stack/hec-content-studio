import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { sampleTimes, prepareEvidence } from '../lib/brain-evidence.mjs';
import { CodexBrain } from '../lib/codex-brain.mjs';
import { JobStore } from '../lib/store.mjs';
import { SerialMedia } from '../lib/serial-media.mjs';
import { configuration } from '../lib/config.mjs';
import { probe } from '../lib/media.mjs';
import { run } from '../lib/process.mjs';

const scratch=path.resolve('..','..','work','tests');
await fs.mkdir(scratch,{recursive:true});
async function directoryFor(t,prefix) {
  const directory=await fs.mkdtemp(path.join(scratch,prefix));
  assert.equal(path.dirname(path.resolve(directory)),scratch);
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return directory;
}
async function mediaFixture(t,{audio=true,black=false}={}) {
  const directory=await directoryFor(t,'drive-evidence-'),source=path.join(directory,'synthetic-source.mp4');
  const config=configuration({DATA_DIR:directory,ASR_MODEL_DIR:path.join(directory,'no-asr-model')});
  const args=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-f','lavfi','-i',
    black?'color=c=black:size=160x288:rate=25:duration=1.2':'testsrc2=size=160x288:rate=25:duration=1.2'];
  if(audio)args.push('-f','lavfi','-i','aevalsrc=0.08*sin(2*PI*220*t)|0.08*sin(2*PI*330*t):s=48000:d=1.2');
  args.push('-map','0:v:0');
  if(audio)args.push('-map','1:a:0','-c:a','aac','-ac','2');
  args.push('-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-t','1.2',source);
  await run(config.ffmpeg,args,{timeout:30_000});
  const asset={id:randomUUID(),name:'SYNTHETIC-source.mp4',path:source,...await probe(source,config)};
  return {directory,source,asset,config};
}
async function imageSize(file,config) {
  const result=await run(config.ffprobe,['-v','error','-show_entries','stream=width,height','-of','json',file],{timeout:30_000});
  const {width,height}=JSON.parse(result.stdout).streams[0];return {width,height};
}

test('drive sampling covers the whole duration with a 96-frame cap while standard keeps 32',()=>{
  const standard=sampleTimes(120),drive=sampleTimes(120,{styleProfile:'late-night-drive'});
  assert.equal(standard.length,32);assert.equal(drive.length,96);
  assert.equal(drive[0],0);assert.equal(drive.at(-1),119.92);
  assert.equal(new Set(drive).size,drive.length);
  assert.ok(drive.every(at=>at>=0&&at<120));
  assert.throws(()=>sampleTimes(120,{styleProfile:'unknown'}),/Stilprofil/);
});

test('real synthetic portrait/stereo source produces readable sheets, full preview, original audio and measured source signals',async t=>{
  const {directory,asset,config}=await mediaFixture(t),output=path.join(directory,'drive');
  const evidence=await prepareEvidence(asset,output,config,undefined,{styleProfile:'late-night-drive'});
  assert.equal(evidence.signalReview.fullDecode,'passed');
  assert.equal(evidence.media.preview,'sequence-preview.mp4');assert.equal(evidence.media.audio,'original-audio.m4a');
  assert.equal(evidence.media.timebase,'source-seconds');assert.equal(evidence.media.audioChannels,2);
  assert.equal(evidence.transcript.status,'unavailable');
  assert.match(evidence.media.notice,/weder gesehen noch angehört/);
  assert.deepEqual(await imageSize(path.join(output,'frame-001.jpg'),config),{width:480,height:480});
  const preview=await probe(path.join(output,evidence.media.preview),config);
  assert.ok(Math.abs(preview.duration-asset.duration)<0.15);assert.equal(preview.audioInfo.channels,2);
  assert.ok(preview.fps<=24);assert.ok(preview.width<=960&&preview.height<=960);
  const audioProbe=await run(config.ffprobe,['-v','error','-show_streams','-show_format','-of','json',path.join(output,evidence.media.audio)],{timeout:30_000});
  const audio=JSON.parse(audioProbe.stdout);
  assert.equal(audio.streams.length,1);assert.equal(audio.streams[0].codec_type,'audio');assert.equal(audio.streams[0].channels,2);
  assert.ok(Math.abs(Number(audio.format.duration)-asset.duration)<0.15);
  assert.deepEqual(evidence.sheetIndex.flatMap(sheet=>sheet.cells.map(cell=>cell.at)),evidence.times);
  assert.equal(evidence.sheetIndex[0].cells[0].frame,'frame-001.jpg');
  assert.ok((await fs.stat(path.join(output,evidence.sheets[0]))).size>0);
  const standardDirectory=path.join(directory,'standard');
  const standard=await prepareEvidence(asset,standardDirectory,config);
  assert.equal(standard.media,undefined);assert.equal(standard.signalReview,undefined);
  assert.deepEqual(await imageSize(path.join(standardDirectory,'frame-001.jpg'),config),{width:384,height:216});
  assert.equal((await fs.readdir(standardDirectory)).some(name=>name.endsWith('.mp4')||name.endsWith('.m4a')),false);
});

test('silent dark synthetic source keeps warning evidence, has no fabricated audio file and is not automatically rejected',async t=>{
  const {directory,asset,config}=await mediaFixture(t,{audio:false,black:true});
  const evidence=await prepareEvidence(asset,path.join(directory,'drive'),config,undefined,{styleProfile:'late-night-drive'});
  assert.equal(evidence.signalReview.fullDecode,'passed');assert.ok(evidence.signalReview.black.length>0);
  assert.equal(evidence.media.audio,null);assert.equal(evidence.media.audioChannels,0);assert.equal(evidence.transcript.status,'no-audio');
  const preview=await probe(path.join(directory,'drive',evidence.media.preview),config);assert.equal(preview.audio,false);
  await assert.rejects(()=>fs.access(path.join(directory,'drive','original-audio.m4a')));
});

test('decoder failure cannot return a passed drive signal review',async t=>{
  const directory=await directoryFor(t,'drive-decode-error-'),source=path.join(directory,'invalid.mp4');
  await fs.writeFile(source,'not a video');
  const config=configuration({DATA_DIR:directory});
  await assert.rejects(()=>prepareEvidence({path:source,duration:1,width:160,height:288,audio:false},path.join(directory,'drive'),config,undefined,{styleProfile:'late-night-drive'}),/fehlgeschlagen/);
});

function drivePlan(assetId,visualTimes=[0,2]) {
  return {summary:'SYNTHETIC contract test; no actual driving claim.',reels:[{title:'SYNTHETIC drive plan',hook:'',caption:'Technical test.',hypothesis:'Verify prepared evidence references.',
    segments:[{assetId,from:0,duration:4,reason:'Synthetic evidence contract.',crop:{mode:'preserve',x:0.5,y:0.5,reason:'Retain synthetic image.'},
      audio:{mode:'original',gainDb:0,reason:'Contract test only.'},evidence:{visualTimes,motion:'Synthetic test.',light:'Synthetic test.',stability:'Synthetic test.',sound:'Not listened.',audioBasis:'not-listened',limitations:['Synthetic fixture.']}}]}]};
}
async function brainFixture(t) {
  const directory=await directoryFor(t,'drive-brain-'),store=new JobStore(directory);await store.initialize();
  const asset={id:randomUUID(),name:'SYNTHETIC-source.mp4',path:path.join(directory,'unused-original.mp4'),duration:10,width:1920,height:1080,audio:true,
    fps:25,colour:{transfer:'bt709',space:'bt709'},audioInfo:{codec:'aac',channels:2,sampleRate:48000}};
  let evidenceOptions;
  const evidence=async(source,output,config,signal,options)=>{
    evidenceOptions=options;await fs.mkdir(output,{recursive:true});
    for(const filename of ['sheet-001.jpg','sequence-preview.mp4','original-audio.m4a'])await fs.writeFile(path.join(output,filename),'SYNTHETIC contract bytes');
    return {times:[0,2,4,6,9],sheets:['sheet-001.jpg'],transcript:{status:'unavailable',text:'',segments:[]},coverage:{type:'sampled-frames',frameCount:5},
      media:{preview:'sequence-preview.mp4',audio:'original-audio.m4a',duration:10},signalReview:{fullDecode:'passed',notice:'SYNTHETIC contract stub.'}};
  };
  const config=configuration({DATA_DIR:directory}),brain=new CodexBrain({get:()=>asset},store,config,new SerialMedia(),{evidence,
    frameExtractor:async(source,at,target)=>fs.writeFile(target,'SYNTHETIC detail frame')});
  await brain.initialize();
  const job=await store.create({id:randomUUID(),title:'SYNTHETIC drive',createdAt:new Date().toISOString(),status:'processing',assets:[asset],outputs:[],
    options:{mode:'codex',count:1,styleProfile:'late-night-drive'}});
  const request=await brain.prepareJob(job,[asset]);
  return {brain,store,job,asset,request,evidenceOptions};
}

test('drive job persists style snapshot and technical metadata and serves only the fixed media names',async t=>{
  const {brain,job,asset,request,evidenceOptions}=await brainFixture(t),manifest=brain.manifest(request);
  assert.equal(evidenceOptions.styleProfile,'late-night-drive');
  assert.equal(request.options.styleProfile,'late-night-drive');assert.equal(request.options.styleBrief.id,'late-night-drive');
  assert.equal(request.options.styleBrief.render.showHook,false);assert.equal(job.options.styleBrief,undefined);
  assert.equal(request.assets[0].fps,25);assert.deepEqual(request.assets[0].colour,asset.colour);assert.deepEqual(request.assets[0].audioInfo,asset.audioInfo);
  assert.ok(!Object.hasOwn(request.assets[0],'path'));
  for(const filename of ['sequence-preview.mp4','original-audio.m4a']){
    assert.ok(request.assets[0].files.includes(filename));assert.ok(brain.file(request.id,asset.id,filename).endsWith(filename));
  }
  assert.ok(manifest.assets[0].mediaUrls.preview.endsWith('/sequence-preview.mp4'));
  assert.throws(()=>brain.file(request.id,asset.id,'other.mp4'),error=>error.status===404);
  assert.throws(()=>brain.file(request.id,asset.id,'../sequence-preview.mp4'),error=>error.status===404);
});

test('drive completion rejects unprepared or single-frame evidence and accepts prepared details without inventing viewing proof',async t=>{
  const {brain,store,job,asset,request}=await brainFixture(t),lease=await brain.claim(request.id,'drive-evidence-worker');
  let handoffs=0;brain.onPlanReady=()=>handoffs++;
  await assert.rejects(()=>brain.complete(request.id,lease.token,drivePlan(asset.id,[0,1])),/nicht vorbereitet/);
  await assert.rejects(()=>brain.complete(request.id,lease.token,drivePlan(asset.id,[0,0.002])),/zwei unterschiedliche vorbereitete/);
  assert.equal(handoffs,0);assert.equal(store.get(job.id).status,'waiting-brain');
  await brain.frame(request.id,lease.token,asset.id,1.5);
  const result=drivePlan(asset.id,[0.003,1.503]);
  await brain.complete(request.id,lease.token,result);assert.equal(handoffs,1);
  assert.equal((await brain.complete(request.id,lease.token,result)).idempotent,true);assert.equal(handoffs,1);
  const saved=JSON.parse(await fs.readFile(path.join(store.directory(job.id),'outputs','plan.json'),'utf8'));
  assert.deepEqual(saved.styleBrief,request.options.styleBrief);
  assert.equal(saved.reels[0].evidence,undefined);assert.equal(saved.reels[0].segments[0].evidence.audioBasis,'not-listened');
  assert.ok(!Object.hasOwn(saved.reels[0].segments[0].evidence,'viewed'));
});

test('drive completion does not treat another asset detail or timestamps beyond tolerance as prepared evidence',async t=>{
  const {brain,asset,request}=await brainFixture(t),lease=await brain.claim(request.id,'drive-bounds-worker');
  await brain.save({...brain.requests.get(request.id),details:[{assetId:randomUUID(),at:1.5,filename:'detail-unrelated.jpg'}]});
  await assert.rejects(()=>brain.complete(request.id,lease.token,drivePlan(asset.id,[0,1.5])),/nicht vorbereitet/);
  await assert.rejects(()=>brain.complete(request.id,lease.token,drivePlan(asset.id,[0,2.004])),/nicht vorbereitet/);
});

async function bridgeFixture(t,{invalid=false}={}) {
  const directory=await directoryFor(t,'drive-bridge-'),id=randomUUID(),assetId=randomUUID(),targetId=randomUUID(),downloaded=[];
  const server=http.createServer((req,res)=>{
    const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
    if(req.url==='/api/brain/heartbeat')return json({ok:true});
    if(req.url==='/api/brain/work')return json({requests:[{id,kind:'job',targetId,title:'SYNTHETIC bridge',status:'queued',isTest:true}]});
    if(req.url==='/api/content?test=true')return json({versions:[]});
    if(req.url===`/api/brain/${id}/claim`)return json({id,kind:'job',targetId,title:'SYNTHETIC bridge',token:'synthetic-local-lease',options:{styleProfile:'late-night-drive'},
      assets:[{id:assetId,name:'SYNTHETIC.mp4',duration:1,width:160,height:288,audio:true,fps:25,times:[0,0.9],sheetIndex:[],
        colour:{transfer:'bt709'},audioInfo:{channels:2},signalReview:{fullDecode:'passed'},sheetUrls:[`/api/brain/${id}/files/${assetId}/sheet-001.jpg`],
        media:{preview:'sequence-preview.mp4',audio:'original-audio.m4a',duration:1},mediaUrls:{preview:`/api/brain/${id}/files/${assetId}/${invalid?'arbitrary.mp4':'sequence-preview.mp4'}`,audio:`/api/brain/${id}/files/${assetId}/original-audio.m4a`}}]});
    if(req.url.startsWith(`/api/brain/${id}/files/${assetId}/`)){downloaded.push(req.url);res.end('SYNTHETIC media download contract');return;}
    res.statusCode=404;json({error:'Unexpected synthetic request.'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const args=[path.resolve('scripts','codex-bridge.mjs'),'next','--kind','job','--test','true','--url',`http://127.0.0.1:${server.address().port}`,'--work-dir',directory,'--run-id','synthetic-drive-evidence'];
  return {directory,id,assetId,downloaded,args};
}

test('bridge next downloads fixed preview/audio paths and returns local media plus honest metadata without a lease token',async t=>{
  const fixture=await bridgeFixture(t),result=await run(process.execPath,fixture.args,{timeout:30_000}),data=JSON.parse(result.stdout);
  assert.equal(data.media.length,1);assert.equal(data.media[0].assetId,fixture.assetId);
  assert.ok(data.media[0].preview.endsWith('-sequence-preview.mp4'));assert.ok(data.media[0].audio.endsWith('-original-audio.m4a'));
  assert.equal(fixture.downloaded.length,3);
  assert.equal(data.assets[0].audioInfo.channels,2);assert.equal(data.assets[0].signalReview.fullDecode,'passed');assert.deepEqual(data.assets[0].times,[0,0.9]);
  assert.ok(!result.stdout.includes('synthetic-local-lease'));
  assert.ok((await fs.stat(data.media[0].preview)).size>0);assert.ok((await fs.stat(data.media[0].audio)).size>0);
});

test('bridge rejects arbitrary mp4 names before fetching them',async t=>{
  const fixture=await bridgeFixture(t,{invalid:true});
  await assert.rejects(()=>run(process.execPath,fixture.args,{timeout:30_000}),/Ungültige Evidence-Datei/);
  assert.equal(fixture.downloaded.some(url=>url.endsWith('/arbitrary.mp4')),false);
});
