import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { validId } from './store.mjs';
import { prepareEvidence,extractFrame } from './brain-evidence.mjs';
import { validateReview } from './brain-review.mjs';
import { validatePlan } from './plan.mjs';
import { getStyleProfile } from './style-profiles.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function failure(message,status=400) {const error=new Error(message);error.status=status;return error;}
const evidenceMediaNames=new Set(['sequence-preview.mp4','original-audio.m4a']);
function verifyPreparedVisualTimes(plan,request) {
  for(const reel of plan.reels)for(const segment of reel.segments) {
    const asset=request.assets.find(item=>item.id===segment.assetId);
    const prepared=[...(asset?.times||[]),...(request.details||[]).filter(item=>item.assetId===segment.assetId).map(item=>item.at)]
      .filter(at=>typeof at==='number'&&Number.isFinite(at));
    const matched=segment.evidence.visualTimes.map(at=>prepared.reduce((nearest,sourceTime)=>
      nearest===undefined||Math.abs(at-sourceTime)<Math.abs(at-nearest)?sourceTime:nearest,undefined));
    if(matched.some((sourceTime,i)=>sourceTime===undefined||Math.abs(segment.evidence.visualTimes[i]-sourceTime)>0.003+1e-9)) {
      throw failure('Late Night Drive: Eine Bildmarke im Szenenbeleg wurde für diese Quelle nicht vorbereitet. Übersicht oder Detailbild verwenden.');
    }
    if(new Set(matched).size<2)throw failure('Late Night Drive benötigt mindestens zwei unterschiedliche vorbereitete Bildmarken pro Szene.');
  }
}
export class CodexBrain {
  constructor(library,store,config,serial,{evidence=prepareEvidence,photos,frameExtractor=extractFrame,frameTimeoutMs=60_000}={}) {
    this.library=library;this.store=store;this.config=config;this.serial=serial;this.evidence=evidence;
    this.photos=photos;this.root=path.join(config.dataDir,'brain');this.requests=new Map();this.lock=Promise.resolve();this.lastSeenAt=null;
    this.frameExtractor=frameExtractor;this.frameTimeoutMs=frameTimeoutMs;
  }
  directory(id) {if(!validId(id))throw failure('Ungültiger Auftrag.');return path.join(this.root,id);}
  previewPriorityWaiting(now=Date.now()) {
    return [...this.requests.values()].some(request=>request.kind==='job'&&
      ((request.status==='claimed'&&Date.parse(request.leaseUntil)>now)||
      (request.status==='queued'&&now-Date.parse(request.createdAt)<90_000)));
  }
  async initialize() {
    await fs.mkdir(this.root,{recursive:true});
    try {this.lastSeenAt=JSON.parse(await fs.readFile(path.join(this.root,'worker.json'),'utf8')).lastSeenAt;}catch{}
    for(const id of await fs.readdir(this.root)) {
      if(!validId(id))continue;
      try {const request=JSON.parse(await fs.readFile(path.join(this.directory(id),'request.json'),'utf8'));
        if(request.id===id&&['clip','job','photo','learning'].includes(request.kind)&&validId(request.targetId)) {
          this.requests.set(id,request);
          const receipt=request.kind==='photo'?this.photos?.get(request.targetId)?.reviewReceipts[request.id]:request.kind==='job'&&this.store.get(request.targetId)?.brainResultReceipt?.requestId===request.id?this.store.get(request.targetId).brainResultReceipt:null;
          if(receipt&&request.status!=='done')await this.save({...request,status:'done',resultHash:receipt.hash,completedAt:new Date().toISOString()});
        }
      }catch{}
    }
  }
  exclusive(task) {const next=this.lock.catch(()=>{}).then(task);this.lock=next;return next;}
  async save(request) {
    const dir=this.directory(request.id);await fs.mkdir(dir,{recursive:true});
    const temp=path.join(dir,`${randomUUID()}.tmp`);await fs.writeFile(temp,JSON.stringify(request,null,2),{mode:0o600});
    await fs.rename(temp,path.join(dir,'request.json'));this.requests.set(request.id,request);
  }
  active(request) {
    if(request.kind==='learning') {const run=this.contentService?.content.state.learningRuns.find(item=>item.id===request.targetId);return run&&['queued','waiting-codex'].includes(run.status)&&run.brainRequestId===request.id;}
    if(request.kind==='photo') {const session=this.photos?.get(request.targetId);return session&&session.status==='waiting-codex'&&session.brainRequestId===request.id&&session.round===request.round;}
    if(request.kind==='clip') {const clip=this.library.get(request.targetId);return clip&&!clip.archived&&clip.brainRequestId===request.id;}
    const job=this.store.get(request.targetId);return job&&job.status==='waiting-brain'&&job.brainRequestId===request.id;
  }
  async heartbeat(worker) {
    if(typeof worker!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(worker))throw failure('Ungültiger Codex-Worker.');
    this.lastSeenAt=new Date().toISOString();
    await fs.writeFile(path.join(this.root,'worker.json'),JSON.stringify({lastSeenAt:this.lastSeenAt,worker}),{mode:0o600});
  }
  work() {return [...this.requests.values()].filter(r=>['queued','claimed'].includes(r.status)&&this.active(r))
    .sort((a,b)=>({learning:0,photo:1,job:2,clip:3}[a.kind]-{learning:0,photo:1,job:2,clip:3}[b.kind])||
      Number(Boolean(b.options?.productionBrief?.revision))-Number(Boolean(a.options?.productionBrief?.revision))||a.createdAt.localeCompare(b.createdAt))
    .map(r=>({id:r.id,kind:r.kind,targetId:r.targetId,title:r.title,isTest:r.options?.isTest===true,status:r.status,createdAt:r.createdAt,worker:r.worker||null,leaseUntil:r.leaseUntil||null}));}
  status() {const pending=this.work();return {provider:'codex',online:Boolean(this.lastSeenAt&&Date.now()-Date.parse(this.lastSeenAt)<30*60_000),lastSeenAt:this.lastSeenAt,
    pendingClips:pending.filter(r=>r.kind==='clip').length,pendingReels:pending.filter(r=>r.kind==='job').length,pendingPhotos:pending.filter(r=>r.kind==='photo').length,pendingLearning:pending.filter(r=>r.kind==='learning').length};}
  async prepare(kind,target,assets,options,signal) {
    const previous=target.brainRequestId&&this.requests.get(target.brainRequestId);
    if(previous&&['queued','claimed'].includes(previous.status)&&this.active(previous))return previous;
    const preparedOptions=kind==='job'?{...options,styleBrief:structuredClone(getStyleProfile(options.styleProfile))}:options;
    const id=randomUUID(),record={id,kind,targetId:target.id,title:target.title||target.name,status:'preparing',createdAt:new Date().toISOString(),options:preparedOptions,assets:[]};
    await this.save(record);
    for(const asset of assets) {
      const evidence=await this.evidence(asset,path.join(this.directory(id),asset.id),this.config,signal,{serial:kind==='clip'?this.serial:undefined,styleProfile:preparedOptions?.styleProfile});
      const mediaFiles=evidence.media?[evidence.media.preview,evidence.media.audio].filter(Boolean):[];
      if(mediaFiles.some(name=>!evidenceMediaNames.has(name))||evidence.media&&
        (evidence.media.preview!=='sequence-preview.mp4'||evidence.media.audio!==null&&evidence.media.audio!=='original-audio.m4a'))throw failure('Ungültige vorbereitete Mediendatei.');
      record.assets.push({id:asset.id,libraryReference:asset.libraryId?`footage:${asset.libraryId}`:kind==='clip'?`footage:${asset.id}`:null,
        name:asset.name,duration:asset.duration,width:asset.width,height:asset.height,audio:asset.audio,
        fps:asset.fps??null,colour:asset.colour??null,audioInfo:asset.audioInfo??null,
        context:asset.context||'',note:asset.note||'',collections:asset.collections||[],catalog:asset.catalog||null,
        ...evidence,files:[...evidence.sheets,...evidence.times.map((_,i)=>`frame-${String(i+1).padStart(3,'0')}.jpg`),...mediaFiles]});
    }
    await this.exclusive(async()=>{
      for(const current of this.requests.values())if(current.id!==id&&current.kind===kind&&current.targetId===target.id&&['queued','claimed','preparing'].includes(current.status))await this.save({...current,status:'cancelled'});
      record.status='queued';await this.save(record);
      if(kind==='clip') await this.library.update(target.id,{brainRequestId:id,analysisStatus:'waiting-codex',status:'ready',stage:'Gespeichert · wartet auf Codex-Auswertung.'});
      else await this.store.update(target.id,{brainRequestId:id,status:'waiting-brain',stage:'Bildfolgen vorbereitet · wartet auf Codex-Schnittplanung.',progress:25});
    });
    return record;
  }
  prepareClip(clip,signal) {return this.prepare('clip',clip,[clip],{goal:'library'},signal);}
  prepareJob(job,assets,signal) {return this.prepare('job',job,assets,job.options,signal);}
  prepareLearning(run) {return this.exclusive(async()=>{
    const previous=run.brainRequestId&&this.requests.get(run.brainRequestId);
    if(previous&&['queued','claimed'].includes(previous.status))return previous;
    const record={id:randomUUID(),kind:'learning',targetId:run.id,title:run.isTest?'TEST · Content-Auswertung':'Content-Auswertung',status:'queued',createdAt:new Date().toISOString(),assets:[],
      options:{goal:'learning',isTest:run.isTest},context:{accountId:run.accountId,facts:run.facts,comparisons:run.comparisons,freshIds:run.freshIds,instruction:run.instruction}};
    await this.save(record);
    await this.contentService.content.transaction(state=>{const current=state.learningRuns.find(item=>item.id===run.id);current.brainRequestId=record.id;current.status='waiting-codex';return {ok:true};});
    return record;
  });}
  preparePhoto(session) {return this.exclusive(async()=>{
    const current=this.photos.get(session.id);if(current.status!=='preparing')throw failure('Foto-Vorbereitung wurde abgebrochen.',409);
    const id=randomUUID(),record={id,kind:'photo',targetId:session.id,round:current.round,title:current.options.title,status:'queued',createdAt:new Date().toISOString(),
      options:current.options,assets:current.assets.map(asset=>{const evidence=current.evidence[asset.id]||{frames:{},overview:[],sheets:[]};
        return {...asset,libraryReference:`footage:${asset.id}`,frames:evidence.overview.map(frameId=>evidence.frames[frameId]),times:evidence.overview.map(frameId=>evidence.frames[frameId].at),sheets:evidence.sheets,
          files:[...Object.values(evidence.frames).map(frame=>frame.filename),...evidence.sheets],coverage:{type:'sampled-photo-frames',frameCount:evidence.overview.length,maxGapSeconds:evidence.maxGapSeconds||0},transcript:{status:'not-required',text:'',segments:[]}};})};
    for(const previous of this.requests.values())if(previous.kind==='photo'&&previous.targetId===session.id&&['queued','claimed'].includes(previous.status))await this.save({...previous,status:'cancelled'});
    await this.save(record);await this.photos.update(session.id,{brainRequestId:id,status:'waiting-codex',stage:'Bildfolgen bereit · wartet auf Codex-Fotoauswahl.',progress:65});return record;
  });}
  claim(id,worker) {return this.exclusive(async()=>{
    const request=this.requests.get(id);if(!request||!this.active(request))throw failure('Der Auftrag ist nicht mehr offen.',409);
    if(!['queued','claimed'].includes(request.status))throw failure('Der Auftrag ist bereits abgeschlossen.',409);
    if(request.status==='claimed'&&Date.parse(request.leaseUntil)>Date.now()&&request.worker!==worker)throw failure('Ein anderer Codex-Lauf bearbeitet den Auftrag.',409);
    await this.heartbeat(worker);
    const next={...request,status:'claimed',worker,token:request.worker===worker&&Date.parse(request.leaseUntil)>Date.now()?request.token:randomUUID(),leaseUntil:new Date(Date.now()+20*60_000).toISOString()};
    await this.save(next);return this.manifest(next);
  });}
  manifest(request) {
    const manifest={...request,assets:request.assets.map(asset=>({...asset,sheetUrls:asset.sheets.map(name=>`/api/brain/${request.id}/files/${asset.id}/${name}`),
      ...(asset.media?{mediaUrls:{preview:`/api/brain/${request.id}/files/${asset.id}/${asset.media.preview}`,
        audio:asset.media.audio?`/api/brain/${request.id}/files/${asset.id}/${asset.media.audio}`:null}}:{})}))};
    if(request.kind==='photo') {
      const session=this.photos.get(request.targetId),reference=session.referenceFrame;
      manifest.subjectReference=reference?{...reference,fileUrl:`/api/brain/${request.id}/files/${reference.assetId}/${reference.filename}`} : null;
      manifest.history={round:session.round,candidates:session.candidates.map(({output,...item})=>item),rejectedFrames:session.rejectedFrames,rounds:session.rounds,
        windows:Object.values(session.windows).map(({times,sheets,...window})=>window)};
    }
    return manifest;
  }
  verify(id,token,{completed=false}={}) {
    const request=this.requests.get(id);
    if(!request||!token||token!==request.token)throw failure('Codex-Auftrag oder Bearbeitungsschlüssel ungültig.',403);
    if(completed&&request.status==='done')return request;
    if(request.status!=='claimed'||!this.active(request)||Date.parse(request.leaseUntil)<=Date.now())throw failure('Die Bearbeitung ist abgelaufen oder wurde abgebrochen.',409);
    return request;
  }
  renew(id,token) {return this.exclusive(async()=>{const request=this.verify(id,token);const next={...request,leaseUntil:new Date(Date.now()+20*60_000).toISOString()};await this.heartbeat(request.worker);await this.save(next);return {leaseUntil:next.leaseUntil};});}
  async frame(id,token,assetId,at) {
    const request=this.verify(id,token),asset=request.assets.find(a=>a.id===assetId);
    if(request.kind==='photo')throw failure('Für Fotos ein gecachtes Detailfenster anfordern.');
    if(!asset||typeof at!=='number'||!Number.isFinite(at)||at<0||at>asset.duration-0.04)throw failure('Die Bildmarke liegt außerhalb der Aufnahme.');
    if((request.details?.length||0)>=64)throw failure('Maximal 64 zusätzliche Einzelbilder pro Auftrag.');
    const source=request.kind==='clip'?this.library.get(request.targetId):this.store.get(request.targetId)?.assets.find(a=>a.id===assetId);
    if(!source)throw failure('Die Originalaufnahme ist nicht verfügbar.',409);
    const filename=`detail-${randomUUID()}.jpg`,file=path.join(this.directory(id),assetId,filename);
    // Waiting behind a preview is not time spent decoding this detail frame.
    await this.serial.run(()=>{this.verify(id,token);const signal=AbortSignal.timeout(this.frameTimeoutMs);return this.frameExtractor(source,at,file,this.config,signal);});
    await this.exclusive(async()=>{const current=this.verify(id,token);await this.save({...current,details:[...(current.details||[]),{assetId,filename,at}]});});
    return {at,fileUrl:`/api/brain/${id}/files/${assetId}/${filename}`};
  }
  file(id,assetId,filename) {
    const request=this.requests.get(id),asset=request?.assets.find(a=>a.id===assetId);
    if(request?.kind==='photo') {if(!asset)throw failure('Fotoquelle nicht gefunden.',404);return this.photos.evidenceFile(request.targetId,assetId,filename);}
    if(!asset||!validId(assetId)||!([...asset.files,...(request.details||[]).filter(d=>d.assetId===assetId).map(d=>d.filename)].includes(filename)))throw failure('Datei nicht gefunden.',404);
    return path.join(this.directory(id),assetId,filename);
  }
  complete(id,token,result) {return this.exclusive(async()=>{
    const pending=this.requests.get(id),receipt=pending?.kind==='photo'?this.photos.get(pending.targetId)?.reviewReceipts[id]:pending?.kind==='learning'?(()=>{const run=this.contentService.content.state.learningRuns.find(item=>item.id===pending.targetId);return run?.status==='done'?{hash:run.resultHash}:null;})():pending?.kind==='job'&&this.store.get(pending.targetId)?.brainResultReceipt?.requestId===id?this.store.get(pending.targetId).brainResultReceipt:null;
    if(receipt&&pending.token===token&&pending.status!=='done')await this.save({...pending,status:'done',resultHash:receipt.hash});
    const request=this.verify(id,token,{completed:true}),resultHash=request.kind==='photo'?(await import('./photo-review.mjs')).photoHash(result):digest(result);
    if(request.status==='done') {if(request.resultHash!==resultHash)throw failure('Der Auftrag wurde bereits mit einem anderen Ergebnis abgeschlossen.',409);return {ok:true,idempotent:true,kind:request.kind,targetId:request.targetId};}
    let readyJob;
    if(request.kind==='learning') {
      await this.contentService.content.learningDone(request.targetId,result);
    } else if(request.kind==='photo') {
      await this.photos.completeReview(request.targetId,id,request.round,result);
    } else if(request.kind==='clip') {
      const clip=this.library.get(request.targetId),review=validateReview(result,clip);
      await this.library.update(clip.id,{...review.catalog,classificationSource:'codex',analysisStatus:'done',analysisError:null,
        stage:'Von Codex ausgewertet.',brainReview:{...review,reviewedAt:new Date().toISOString(),provider:'codex',coverage:request.assets[0].coverage,transcriptStatus:request.assets[0].transcript.status}});
    } else {
      const job=this.store.get(request.targetId);
      if(result?.decision==='no-reel') {
        if(typeof result.reason!=='string'||!result.reason.trim()||result.reason.length>1600)throw failure('Eine Begründung für fehlendes Reel-Material ist erforderlich.');
        await this.store.update(job.id,{status:'no-reel',stage:'Codex hat keinen tragfähigen Reel-Schnitt gefunden.',summary:result.reason,progress:100,brainResultReceipt:{requestId:id,hash:resultHash}});
        await this.contentService?.observe(job);
      } else {
        let plan=validatePlan(result,job.assets,job.options.count,job.options);
        if(getStyleProfile(job.options.styleProfile).id==='late-night-drive')verifyPreparedVisualTimes(plan,request);
        if(this.contentService)plan=this.contentService.content.validatePlan(job.id,result,plan);
        plan={...plan,provider:'codex',reviewedAt:new Date().toISOString(),
          styleBrief:structuredClone(request.options.styleBrief||getStyleProfile(job.options.styleProfile))};
        await this.contentService?.content.planReceived(job.id,plan);
        const directory=path.join(this.store.directory(job.id),'outputs');await fs.mkdir(directory,{recursive:true});
        const temp=path.join(directory,`${randomUUID()}.tmp`);await fs.writeFile(temp,JSON.stringify(plan,null,2),{mode:0o600});await fs.rename(temp,path.join(directory,'plan.json'));
        await this.store.update(job.id,{status:'queued',stage:'Codex-Schnittplan erhalten · wartet auf FFmpeg.',summary:plan.summary,progress:40,brainResultReceipt:{requestId:id,hash:resultHash}});
        readyJob=job.id;
      }
    }
    await this.save({...request,status:'done',completedAt:new Date().toISOString(),resultHash});
    if(request.kind==='photo')this.onPhotoReady?.(request.targetId);
    if(readyJob)this.onPlanReady?.(readyJob);
    return {ok:true,idempotent:false,kind:request.kind,targetId:request.targetId};
  });}
  fail(id,token,message) {return this.exclusive(async()=>{
    const request=this.verify(id,token);const reason=String(message||'Die Codex-Auswertung konnte nicht abgeschlossen werden.').slice(0,500);
    await this.save({...request,status:'error',error:reason});
    if(request.kind==='learning')await this.contentService.content.transaction(state=>{const run=state.learningRuns.find(item=>item.id===request.targetId);run.status='error';run.error=reason;return {ok:true};});
    else if(request.kind==='photo')await this.photos.update(request.targetId,{status:'error',resumeStatus:'queued',error:reason,stage:'Codex-Fotoauswahl prüfen.'});
    else if(request.kind==='clip')await this.library.update(request.targetId,{analysisStatus:'error',analysisError:reason,stage:'Codex-Auswertung prüfen.'});
    else await this.store.update(request.targetId,{status:'error',error:reason,stage:'Codex-Schnittplanung prüfen.'});
    return {ok:true};
  });}
  cancel(kind,targetId) {return this.exclusive(async()=>{for(const request of this.requests.values())if(request.kind===kind&&request.targetId===targetId&&['preparing','queued','claimed'].includes(request.status))await this.save({...request,status:'cancelled'});});}
  window(id,token,body) {const request=this.verify(id,token);if(request.kind!=='photo')throw failure('Detailfenster sind Foto-Aufträgen zugeordnet.');return this.photoQueue.requestWindow(request.targetId,body);}
  windowStatus(id,windowId) {const request=this.requests.get(id);if(!request||request.kind!=='photo')throw failure('Foto-Auftrag nicht gefunden.',404);return this.photoQueue.publicWindow(request.targetId,windowId);}
}
