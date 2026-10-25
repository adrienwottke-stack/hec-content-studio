import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import * as media from './photo-media.mjs';
import { writePhotoZip,verifyPhotoZip } from './photo-zip.mjs';
import { photoError } from './photo-review.mjs';

export class PhotoQueue {
  constructor(photos,library,config,serial,{photoMedia=media,brain}={}) {
    this.photos=photos;this.library=library;this.config=config;this.serial=serial;this.media=photoMedia;this.brain=brain;
    this.waiting=[];this.running=null;this.controller=null;this.closing=false;
  }
  enqueue(id,windowId=null) {
    const key=`${id}:${windowId||'session'}`;
    if(this.closing||this.running?.key===key||this.waiting.some(item=>item.key===key))return;
    this.waiting.push({id,windowId,key});setImmediate(()=>this.drain());
  }
  resume(){for(const session of this.photos.list()) {
    if(['queued','export-queued'].includes(session.status))this.enqueue(session.id);
    if(session.status==='waiting-codex')for(const window of Object.values(session.windows))if(window.status==='queued')this.enqueue(session.id,window.id);
  }}
  async drain() {
    if(this.closing||this.running||!this.waiting.length)return;
    const task=this.waiting.shift();if(!this.photos.get(task.id))return this.drain();this.running=task;this.controller=new AbortController();const signal=this.controller.signal;
    try {
      if(task.windowId)await this.processWindow(task.id,task.windowId,signal);
      else {const session=this.photos.get(task.id);if(session.status==='queued')await this.prepare(task.id,signal);else if(session.status==='export-queued')await this.export(task.id,signal);}
    } catch(error) {
      const session=this.photos.get(task.id);
      if(session.status!=='cancelled') {
        if(task.windowId)await this.photos.mutate(task.id,current=>{const window=current.windows[task.windowId];window.status=signal.aborted?'queued':'error';window.error=signal.aborted?null:'Detailfenster konnte nicht vorbereitet werden.';});
        else await this.photos.update(task.id,{status:signal.aborted?session.status==='exporting'?'export-queued':'queued':'error',
          resumeStatus:session.status==='exporting'?'export-queued':'queued',error:signal.aborted?null:'Die Foto-Verarbeitung konnte nicht abgeschlossen werden. Du kannst sie fortsetzen.',stage:signal.aborted?'Verarbeitung wird nach dem Neustart fortgesetzt.':'Foto-Verarbeitung prüfen.'});
      }
      if(!signal.aborted)console.error('Fotos:',task.id,error.message);
    } finally {this.running=null;this.controller=null;if(!this.closing)setImmediate(()=>this.drain());}
  }
  source(session,asset) {
    const source=this.library.get(asset.id);if(!source)throw photoError('Die Originalaufnahme ist nicht mehr verfügbar.',409);
    return {...source,...asset,path:source.path};
  }
  directory(id,assetId){return path.join(this.photos.directory(id),'evidence',assetId);}
  async frame(id,asset,at,signal) {
    signal.throwIfAborted();let frame=this.photos.cached(id,asset.id,at);if(frame)return frame;
    frame=await this.serial.run(()=>this.media.extractPhotoPreview(this.source(this.photos.get(id),asset),at,this.directory(id,asset.id),this.config,signal),signal);
    signal.throwIfAborted();await this.photos.addFrame(id,asset.id,frame,at);return this.photos.cached(id,asset.id,at);
  }
  async sheets(id,asset,frames,key,signal) {
    const sheets=[];
    for(let i=0;i<frames.length;i+=12) {
      const names=await this.serial.run(()=>this.media.makePhotoSheets(asset,frames.slice(i,i+12),this.directory(id,asset.id),`${key}-${i/12}`,this.config,signal),signal);sheets.push(...names);
    }
    return sheets;
  }
  async prepare(id,signal) {
    let session=await this.photos.mutate(id,current=>{signal.throwIfAborted();if(current.status!=='queued')throw new DOMException('Abgebrochen','AbortError');Object.assign(current,{status:'preparing',stage:'Originale und Foto-Bildfolgen werden geprüft.',progress:5,error:null});});
    for(let i=0;i<session.assets.length;i++) {
      signal.throwIfAborted();let asset=this.photos.get(id).assets[i];
      try {
        if(asset.streamIndex===undefined) {
          const metadata=await this.serial.run(()=>this.media.photoMetadata(this.source(session,asset),this.config,signal),signal);
          if(metadata.duration>this.config.maxSourceSeconds)throw new Error('Fotoquelle überschreitet das Dauerlimit.');
          await this.photos.mutate(id,current=>Object.assign(current.assets[i],metadata,{error:null}));asset=this.photos.get(id).assets[i];
        }
        const times=this.media.photoSampleTimes(asset.duration,session.assets.length),frames=[];
        for(let j=0;j<times.length;j++) {
          const frame=await this.frame(id,asset,times[j],signal);frames.push(frame);
          await this.photos.update(id,{stage:`Aufnahme ${i+1}/${session.assets.length}: Übersicht ${j+1}/${times.length}.`,progress:Math.round(5+55*(i+j/times.length)/session.assets.length)});
        }
        const evidence=this.photos.get(id).evidence[asset.id];
        const sheets=evidence.sheets.length?evidence.sheets:await this.sheets(id,asset,frames,'overview',signal);
        await this.photos.mutate(id,current=>{const item=current.evidence[asset.id];item.overview=[...new Set(frames.map(frame=>frame.id))];item.sheets=sheets;
          item.maxGapSeconds=Math.max(0,...frames.slice(1).map((frame,index)=>Math.round((frame.at-frames[index].at)*1e6)/1e6));current.assets[i].error=null;});
      } catch(error) {
        if(signal.aborted)throw error;
        await this.photos.mutate(id,current=>{current.assets[i].error='Diese Quelle konnte nicht vollständig für Fotos vorbereitet werden.';});
      }
    }
    session=this.photos.get(id);const reference=session.options.subjectReference,asset=session.assets.find(item=>item.id===reference.assetId);
    if(asset.error)throw new Error('Die gewählte Referenzquelle ist nicht lesbar.');
    const referenceFrame=await this.frame(id,asset,reference.at,signal);await this.photos.update(id,{referenceFrame,progress:65});
    signal.throwIfAborted();await this.brain.preparePhoto(this.photos.get(id));
  }
  async requestWindow(id,raw) {
    const window=await this.photos.requestWindow(id,raw);if(window.status==='queued')this.enqueue(id,window.id);return this.publicWindow(id,window.id);
  }
  publicWindow(id,windowId) {
    const session=this.photos.get(id),window=session?.windows[windowId];if(!window)throw photoError('Detailfenster nicht gefunden.',404);
    return {id:window.id,assetId:window.assetId,from:window.from,to:window.to,step:window.step,status:window.status,processed:window.processed,requestedCount:window.times.length,error:window.error||null,
      frames:window.frameIds.map(frameId=>{const frame=session.evidence[window.assetId].frames[frameId];return {...frame,fileUrl:`/api/brain/${session.brainRequestId}/files/${window.assetId}/${frame.filename}`};}),
      sheetUrls:window.sheets.map(name=>`/api/brain/${session.brainRequestId}/files/${window.assetId}/${name}`),
      notice:'Stichproben innerhalb dieses Zeitfensters. Tatsächliche Decoder-Zeitmarken; keine vollständige Videosichtung.'};
  }
  async processWindow(id,windowId,signal) {
    let session=this.photos.get(id),window=session.windows[windowId];if(window.status!=='queued'||session.status!=='waiting-codex')return;
    const asset=session.assets.find(item=>item.id===window.assetId),frames=[];await this.photos.mutate(id,current=>{current.windows[windowId].status='running';});
    for(let i=0;i<window.times.length;i++) {
      const frame=await this.frame(id,asset,window.times[i],signal);frames.push(frame);
      await this.photos.mutate(id,current=>{const item=current.windows[windowId];item.processed=i+1;item.frameIds=[...new Set(frames.map(frame=>frame.id))];current.stage=`Detailfenster: ${i+1}/${window.times.length} Bilder vorbereitet.`;current.progress=70;});
    }
    const unique=[...new Map(frames.map(frame=>[frame.id,frame])).values()],sheets=await this.sheets(id,asset,unique,windowId,signal);
    signal.throwIfAborted();await this.photos.mutate(id,current=>{Object.assign(current.windows[windowId],{status:'done',sheets,error:null});current.stage='Detailbilder bereit · wartet auf Codex-Auswahl.';});
  }
  async export(id,signal) {
    await this.photos.mutate(id,current=>{signal.throwIfAborted();if(current.status!=='export-queued')throw new DOMException('Abgebrochen','AbortError');Object.assign(current,{status:'exporting',stage:'Fotos werden aus der Original-Videospur exportiert.',progress:80});});
    const dir=path.join(this.photos.directory(id),'outputs');await fs.mkdir(dir,{recursive:true});
    let session=this.photos.get(id);const pending=session.candidates.filter(item=>!item.rejected);
    for(let i=0;i<pending.length;i++) {
      signal.throwIfAborted();const candidate=this.photos.get(id).candidates.find(item=>item.frameId===pending[i].frameId);if(candidate.rejected)continue;
      const asset=this.photos.get(id).assets.find(item=>item.id===candidate.assetId),frame=this.photos.get(id).evidence[asset.id].frames[candidate.frameId],filename=`foto-${candidate.frameId}.jpg`,target=path.join(dir,filename);
      if(candidate.output) {
        try {const verified=await this.serial.run(()=>this.media.verifyPhotoImage(target,candidate.output,this.config,signal),signal);if(verified.sha256===candidate.output.sha256)continue;}catch(error){if(signal.aborted)throw error;}
      }
      const temp=path.join(dir,`${randomUUID()}.jpg`);
      try {
        const output=await this.serial.run(()=>this.media.exportPhotoNative(this.source(session,asset),frame,temp,this.config,signal),signal);
        signal.throwIfAborted();const duplicate=this.photos.get(id).candidates.find(item=>item.frameId!==candidate.frameId&&item.output?.sha256===output.sha256);
        if(duplicate) {
          await this.photos.mutate(id,current=>{const item=current.candidates.find(item=>item.frameId===candidate.frameId);item.rejected=true;item.favorite=false;item.duplicateOf=duplicate.frameId;item.limitations.push('Identischer JPEG-Inhalt wurde bereits exportiert.');current.selectionVersion++;});continue;
        }
        await fs.rename(temp,target);
        await this.photos.mutate(id,current=>{current.candidates.find(item=>item.frameId===candidate.frameId).output={...output,filename};current.stage=`Originalexport ${i+1}/${pending.length} geprüft.`;current.progress=Math.round(80+15*(i+1)/pending.length);});
      } finally {await fs.rm(temp,{force:true});}
    }
    session=this.photos.get(id);const version=session.selectionVersion,selected=session.candidates.filter(item=>item.favorite&&!item.rejected&&item.output).sort((a,b)=>a.round-b.round||a.rank-b.rank);
    if(selected.length) {
      const filename=`auswahl-v${version}.zip`,target=path.join(dir,filename),entries=selected.map(item=>({name:item.output.filename,path:path.join(dir,item.output.filename)}));
      const existing=session.exports.find(item=>item.version===version);
      if(existing)await verifyPhotoZip(target,entries);
      else {
        const temp=path.join(dir,`${randomUUID()}.zip`);
        try {
          await this.serial.run(()=>writePhotoZip(temp,entries,signal),signal);signal.throwIfAborted();await fs.rename(temp,target);
          const hash=createHash('sha256');for await(const chunk of createReadStream(target)){signal.throwIfAborted();hash.update(chunk);}
          const record={filename,version,frameIds:selected.map(item=>item.frameId),count:selected.length,bytes:(await fs.stat(target)).size,sha256:hash.digest('hex'),createdAt:new Date().toISOString()};
          await this.photos.mutate(id,current=>current.exports.push(record));
        } finally {await fs.rm(temp,{force:true});}
      }
    }
    signal.throwIfAborted();await this.photos.mutate(id,current=>{
      if(current.status==='cancelled')return;
      current.status=current.subjectStatus==='unclear'?'needs-subject':current.candidates.some(item=>!item.rejected)?'ready':'empty';current.progress=100;
      current.stage=current.status==='ready'?'Geprüfte Fotos und Download bereit.':current.status==='needs-subject'?'Hauptperson ist unklar. Bitte eine eindeutigere Referenz wählen.':'Keine weiteren überzeugenden Bilder gefunden.';
    });
  }
  cancel(id){this.waiting=this.waiting.filter(item=>item.id!==id);if(this.running?.id===id)this.controller?.abort();}
  async close(){this.closing=true;this.controller?.abort();const deadline=Date.now()+20_000;while(this.running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));}
}
