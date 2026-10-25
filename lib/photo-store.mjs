import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validId } from './store.mjs';
import { photoOptions,photoWindow,photoHash,photoError,photoLimits,validatePhotoReview } from './photo-review.mjs';

const now=()=>new Date().toISOString();
export class PhotoStore {
  constructor(root,library,config) {this.root=path.join(root,'photos');this.library=library;this.config=config;this.sessions=new Map();this.lock=Promise.resolve();}
  exclusive(task){const next=this.lock.catch(()=>{}).then(task);this.lock=next;return next;}
  directory(id){if(!validId(id))throw photoError('Ungültige Foto-Session.',404);return path.join(this.root,id);}
  get(id){return this.sessions.get(id);}
  list(){return [...this.sessions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async initialize() {
    await fs.mkdir(this.root,{recursive:true});
    for(const id of await fs.readdir(this.root))if(validId(id)) {
      try {
        const session=JSON.parse(await fs.readFile(path.join(this.directory(id),'session.json'),'utf8'));if(session.id!==id||!Array.isArray(session.assetIds))continue;
        if(session.status==='preparing')session.status='queued';if(session.status==='exporting')session.status='export-queued';
        for(const window of Object.values(session.windows))if(window.status==='running')window.status='queued';
        await this.save(session);
      }catch(error){if(error.code!=='ENOENT')console.error('Eine Foto-Session konnte nicht gelesen werden:',id);}
    }
  }
  async save(session) {
    const dir=this.directory(session.id);await fs.mkdir(dir,{recursive:true});const temp=path.join(dir,`${randomUUID()}.tmp`);
    await fs.writeFile(temp,JSON.stringify(session,null,2),{mode:0o600});await fs.rename(temp,path.join(dir,'session.json'));this.sessions.set(session.id,session);return session;
  }
  mutate(id,task){return this.exclusive(async()=>{const original=this.get(id);if(!original)throw photoError('Foto-Session nicht gefunden.',404);const session=structuredClone(original);await task(session);session.updatedAt=now();return this.save(session);});}
  update(id,patch){return this.mutate(id,session=>Object.assign(session,patch));}
  create(raw) {return this.exclusive(async()=>{
    const existing=this.get(raw?.requestId);
    const source=existing?{get:id=>{const asset=existing.assets.find(item=>item.id===id);return asset?{...asset,previewReady:true,archived:false}:null;}}:this.library;
    const normalized=photoOptions(raw,source,this.config),requestHash=photoHash(normalized);
    if(existing){if(existing.requestHash!==requestHash)throw photoError('Diese Auftragsreferenz gehört zu einer anderen Foto-Session.',409);return existing;}
    if(this.list().filter(item=>['queued','preparing','waiting-codex','export-queued','exporting'].includes(item.status)).length>=10)throw photoError('Zehn Foto-Sessions sind bereits offen. Bitte eine Auswahl abwarten.',429);
    const assets=normalized.assetIds.map(id=>{const clip=this.library.get(id);return {id,name:clip.name,sha256:clip.sha256,duration:clip.duration,width:clip.width,height:clip.height,
      catalog:{title:clip.title,description:clip.description||'',tags:clip.tags||[]}};});
    return this.save({id:raw.requestId,requestHash,...normalized,assets,createdAt:now(),updatedAt:now(),status:'queued',stage:'Wartet auf die Foto-Vorbereitung.',progress:0,
      round:1,rounds:[{number:1,createdAt:now(),note:''}],evidence:{},windows:{},candidates:[],rejectedFrames:[],selectionVersion:0,operations:{},reviewReceipts:{},exports:[]});
  });}
  async addFrame(id,assetId,frame,requestedAt) {
    return this.mutate(id,session=>{const evidence=session.evidence[assetId]||={frames:{},byTime:{},overview:[],sheets:[]};
      evidence.frames[frame.id]||=frame;evidence.byTime[String(requestedAt)]=frame.id;});
  }
  cached(id,assetId,at){const evidence=this.get(id)?.evidence[assetId];return evidence?.frames[evidence.byTime[String(at)]];}
  requestWindow(id,raw) {return this.mutate(id,session=>{
    if(session.status!=='waiting-codex')throw photoError('Diese Foto-Session wartet gerade nicht auf Bildprüfung.',409);
    const asset=session.assets.find(item=>item.id===raw?.assetId);if(!asset||asset.error)throw photoError('Fotoquelle ist nicht verfügbar.');
    const window=photoWindow(raw,asset),windowId=photoHash({assetId:window.assetId,from:window.from,to:window.to,step:window.step}).slice(0,32);
    if(session.windows[windowId])return;
    const reservations=Object.values(session.windows),total=new Set(),perAsset=new Set();
    for(const item of [...reservations,window])for(const at of item.times){total.add(`${item.assetId}:${at}`);if(item.assetId===asset.id)perAsset.add(at);}
    if(total.size>photoLimits.detailPerSession||perAsset.size>photoLimits.detailPerAsset)throw photoError('Das Detailbudget ist ausgeschöpft. Vorhandene Fenster vergleichen und die Teilabdeckung benennen.',409);
    session.windows[windowId]={id:windowId,...window,status:'queued',processed:0,frameIds:[],sheets:[],createdAt:now(),round:session.round};
    session.stage='Gute Fotomomente werden genauer geprüft.';
  }).then(session=>{const asset=session.assets.find(item=>item.id===raw.assetId),window=photoWindow(raw,asset);return session.windows[photoHash({assetId:window.assetId,from:window.from,to:window.to,step:window.step}).slice(0,32)];});}
  completeReview(id,requestId,round,result) {return this.mutate(id,session=>{
    const digest=photoHash(result),receipt=session.reviewReceipts[requestId];
    if(receipt){if(receipt.hash!==digest)throw photoError('Der Foto-Auftrag wurde bereits mit einem anderen Ergebnis bestätigt.',409);return;}
    if(session.round!==round||session.brainRequestId!==requestId||session.status!=='waiting-codex')throw photoError('Diese Foto-Auswahlrunde ist nicht mehr offen.',409);
    const review=validatePhotoReview(result,session);
    for(const item of review.candidates)session.candidates.push({...item,round,favorite:item.tier==='favorite',rejected:false,createdAt:now()});
    for(const item of review.rejections)if(!session.rejectedFrames.some(previous=>previous.frameId===item.frameId))session.rejectedFrames.push({...item,round});
    session.rounds[round-1].review={...review,completedAt:now()};session.reviewReceipts[requestId]={hash:digest,round};
    session.summary=review.summary;session.limitations=review.limitations;session.subjectStatus=review.subjectStatus;
    session.selectionVersion++;session.status='export-queued';session.stage=review.candidates.length?'Geprüfte Fotos werden aus den Originalen exportiert.':'Sichtungsbefund wird gespeichert.';session.progress=75;
  });}
  operation(session,raw,type,payload) {
    if(!validId(raw?.requestId))throw photoError('Eine gültige Auftragsreferenz ist erforderlich.');
    const hash=photoHash({type,payload}),previous=session.operations[raw.requestId];
    if(previous){if(previous.hash!==hash)throw photoError('Diese Referenz wurde mit anderen Parametern verwendet.',409);return true;}
    if(Object.keys(session.operations).length>=500)throw photoError('Zu viele Änderungen in dieser Session.');
    session.operations[raw.requestId]={hash,type,createdAt:now()};return false;
  }
  more(id,raw) {return this.mutate(id,session=>{
    if(!raw||Object.keys(raw).some(key=>!['requestId','note'].includes(key))||raw.note!==undefined&&(typeof raw.note!=='string'||raw.note.length>1000))throw photoError('Ungültige Auswahlfortsetzung.');
    if(this.operation(session,raw,'more',{note:raw.note||''}))return;
    if(!['ready','empty','cancelled'].includes(session.status))throw photoError('Die aktuelle Foto-Runde bitte zuerst abschließen.',409);
    if(session.round>=photoLimits.rounds)throw photoError('Das Budget von fünf Auswahlrunden ist erreicht. Eine neue Session mit anderer Auswahl anlegen.',409);
    session.round++;session.rounds.push({number:session.round,createdAt:now(),note:raw.note||''});session.brainRequestId=null;
    session.status='queued';session.stage='Zusätzliche Fotomotive werden vorbereitet.';session.progress=0;session.error=null;
  });}
  selection(id,raw) {return this.mutate(id,session=>{
    if(!raw||Object.keys(raw).some(key=>!['requestId','frameId','action'].includes(key))||!['favorite','unfavorite','reject','restore'].includes(raw.action))throw photoError('Ungültige Foto-Auswahländerung.');
    if(this.operation(session,raw,'selection',{frameId:raw.frameId,action:raw.action}))return;
    const candidate=session.candidates.find(item=>item.frameId===raw.frameId);if(!candidate)throw photoError('Das Foto gehört nicht zu dieser Auswahl.');
    if(raw.action==='reject'){candidate.rejected=true;candidate.favorite=false;}
    if(raw.action==='restore')candidate.rejected=false;
    if(raw.action==='favorite'){candidate.rejected=false;candidate.favorite=true;}
    if(raw.action==='unfavorite')candidate.favorite=false;
    session.selectionVersion++;
  });}
  requestExport(id,raw) {return this.mutate(id,session=>{
    if(!raw||Object.keys(raw).some(key=>key!=='requestId'))throw photoError('Ungültiger Fotoexport.');
    const previous=session.operations[raw.requestId];
    if(previous){if(previous.type!=='export')throw photoError('Diese Referenz gehört zu einem anderen Auftrag.',409);return;}
    if(this.operation(session,raw,'export',{version:session.selectionVersion}))return;
    if(!['ready','empty','cancelled','needs-subject'].includes(session.status))throw photoError('Bitte die laufende Foto-Verarbeitung abwarten.',409);
    session.status='export-queued';session.stage='Deine aktuelle Auswahl wird als Download vorbereitet.';session.error=null;
  });}
  cancel(id) {return this.mutate(id,session=>{
    if(['cancelled','ready','empty','needs-subject'].includes(session.status))return;
    session.resumeStatus=['exporting','export-queued'].includes(session.status)?'export-queued':'queued';session.status='cancelled';session.stage='Foto-Auftrag abgebrochen. Vorhandene Bilder bleiben erhalten.';
    for(const window of Object.values(session.windows))if(['running','queued'].includes(window.status))window.status='cancelled';
  });}
  retry(id) {return this.mutate(id,session=>{
    if(!['error','cancelled'].includes(session.status))throw photoError('Diese Session braucht gerade keinen Neustart.',409);
    session.status=session.resumeStatus||'queued';session.stage='Foto-Verarbeitung wird fortgesetzt.';session.error=null;
    for(const window of Object.values(session.windows))if(['cancelled','error'].includes(window.status))window.status='queued';
  });}
  evidenceFile(id,assetId,filename) {
    const session=this.get(id),evidence=session?.evidence[assetId],allowed=evidence&&[...Object.values(evidence.frames).map(item=>item.filename),...evidence.sheets,...Object.values(session.windows).filter(item=>item.assetId===assetId).flatMap(item=>item.sheets)];
    if(!session?.assetIds.includes(assetId)||!allowed?.includes(filename)||path.basename(filename)!==filename)throw photoError('Fotovorschau nicht gefunden.',404);
    return path.join(this.directory(id),'evidence',assetId,filename);
  }
  exportFile(id,filename) {
    const session=this.get(id),allowed=[...session?.candidates.filter(item=>item.output).map(item=>item.output.filename)||[],...session?.exports.map(item=>item.filename)||[]];
    if(!allowed.includes(filename)||path.basename(filename)!==filename)throw photoError('Fotoexport nicht gefunden.',404);
    return path.join(this.directory(id),'outputs',filename);
  }
  public(session) {
    const preview=(assetId,frameId)=>{const frame=session.evidence[assetId]?.frames[frameId];return frame?`/api/photos/${session.id}/evidence/${assetId}/${frame.filename}`:null;};
    const reference=session.referenceFrame;
    return {id:session.id,title:session.options.title,createdAt:session.createdAt,updatedAt:session.updatedAt,status:session.status,stage:session.stage,progress:session.progress,error:session.error||null,
      options:session.options,round:session.round,summary:session.summary||'',subjectStatus:session.subjectStatus,limitations:session.limitations||[],
      referenceUrl:reference?preview(reference.assetId,reference.id):null,selectionVersion:session.selectionVersion,
      assets:session.assets.map(({id,name,duration,width,height,error,colorWarning})=>({id,name,duration,width,height,error,colorWarning,
        overview:{count:session.evidence[id]?.overview.length||0,maxGapSeconds:session.evidence[id]?.maxGapSeconds||0},
        windows:Object.values(session.windows).filter(item=>item.assetId===id).map(({id,from,to,step,status,processed,frameIds,error})=>({id,from,to,step,status,processed,frameCount:frameIds.length,error}))})),
      rounds:session.rounds.map(({number,createdAt,review})=>({number,createdAt,summary:review?.summary,sourceReviews:review?.sourceReviews,reviewedWindowIds:review?.reviewedWindowIds})),
      candidates:session.candidates.map(item=>({...item,previewUrl:preview(item.assetId,item.frameId),
        sourceName:session.assets.find(asset=>asset.id===item.assetId)?.name,sourceUrl:`/?view=library&clip=${item.assetId}&at=${item.at}`,
        imageUrl:item.output?`/api/photos/${session.id}/files/${item.output.filename}`:null})),
      exports:session.exports.map(item=>({...item,url:`/api/photos/${session.id}/files/${item.filename}?download=1`})),
      selectedFrameIds:session.candidates.filter(item=>item.favorite&&!item.rejected).map(item=>item.frameId),
      rejectedFrameIds:[...session.candidates.filter(item=>item.rejected).map(item=>item.frameId),...session.rejectedFrames.map(item=>item.frameId)]};
  }
}
