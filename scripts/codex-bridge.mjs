import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncVault } from '../lib/vault-sync.mjs';
import { readVaultContext } from '../lib/vault-context.mjs';

const [command='status',...args]=process.argv.slice(2);
const flags={};for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw new Error('Argumente als --name wert angeben.');flags[args[i].slice(2)]=args[i+1];}
const env={...process.env};
if(flags['env-file'])for(const row of (await fs.readFile(path.resolve(flags['env-file']),'utf8')).split(/\r?\n/)) {
  const match=row.match(/^([A-Z_]+)=(.*)$/);if(match)env[match[1]]=match[2];
}
const base=new URL(flags.url||env.STUDIO_URL||`https://${env.STUDIO_DOMAIN||'reels.127.0.0.1.sslip.io'}`);
if(base.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw new Error('Studio-Zugang nur über HTTPS oder localhost.');
const root=path.resolve(flags['work-dir']||'work/codex-brain');await fs.mkdir(root,{recursive:true});
const workerPath=path.join(root,'worker.json');let worker;
try{worker=JSON.parse(await fs.readFile(workerPath,'utf8')).id;}catch{worker=`codex-${randomUUID()}`;await fs.writeFile(workerPath,JSON.stringify({id:worker}),{mode:0o600});}
if(flags['run-id']) {
  if(!/^[a-zA-Z0-9_-]{8,32}$/.test(flags['run-id']))throw new Error('--run-id: 8 bis 32 Buchstaben/Ziffern für genau diesen lokalen Durchlauf.');
  worker=`${worker.slice(0,44)}-${flags['run-id']}`;
}
const headers={'x-reel-studio':'1'};
if(env.STUDIO_PASSWORD)headers.authorization='Basic '+Buffer.from(`${env.STUDIO_USER||'hec'}:${env.STUDIO_PASSWORD}`).toString('base64');
async function request(endpoint,body) {
  const response=await fetch(new URL(endpoint,base),{method:body?'POST':'GET',redirect:'error',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90_000)});
  const data=await response.json();if(!response.ok)throw new Error(`Studio HTTP ${response.status}: ${data.error||'Anfrage fehlgeschlagen.'}`);return data;
}
async function download(url,target) {
  const parsed=new URL(url,base);
  if(parsed.origin!==base.origin||parsed.search||parsed.hash||!/^\/api\/brain\/[a-f0-9-]+\/files\/[a-f0-9-]+\/(?:(?:sheet-\d{3}|frame-\d{3}|detail-[a-f0-9-]+|frame-[a-f0-9]{32}|sheet-(?:overview|[a-f0-9]{32})-\d+-\d{3})\.jpg|sequence-preview\.mp4|original-audio\.m4a)$/.test(parsed.pathname))throw new Error('Ungültige Evidence-Datei.');
  const response=await fetch(parsed,{headers,redirect:'error',signal:AbortSignal.timeout(60_000)});
  if(!response.ok)throw new Error(`Evidence-Download HTTP ${response.status}`);
  await fs.writeFile(target,Buffer.from(await response.arrayBuffer()),{mode:0o600});
}
async function manifest() {
  if(!flags.manifest)throw new Error('--manifest ist erforderlich.');
  return JSON.parse(await fs.readFile(path.resolve(flags.manifest),'utf8'));
}
try {
  await request('/api/brain/heartbeat',{worker});
  if(command==='status'||command==='list')console.log(JSON.stringify(await request(command==='list'?'/api/brain/work':'/api/brain/status'),null,2));
  else if(command==='catalog-status') {
    const {clips}=await request('/api/library');
    const active=clips.filter(clip=>!clip.archived),reviewed=clip=>clip.classificationSource==='codex'&&clip.analysisStatus==='done'&&Boolean(clip.brainReview);
    const pending=active.filter(clip=>clip.status!=='error'&&!reviewed(clip));
    console.log(JSON.stringify({total:active.length,reviewed:active.filter(reviewed).length,pending:pending.map(({id,name,status,analysisStatus,collections})=>({id,name,status,analysisStatus,collections})),
      failures:active.filter(clip=>clip.status==='error').map(({id,name,error})=>({id,name,error})),complete:pending.length===0},null,2));
  } else if(command==='vault-context') {
    if(!flags.vault)throw new Error('--vault mit dem lokalen Obsidian-Vault erforderlich.');
    const context=await readVaultContext({vault:flags.vault});
    await fs.writeFile(path.join(root,'vault-context.json'),JSON.stringify(context,null,2),{mode:0o600});
    console.log(JSON.stringify(context,null,2));
  }
  else if(command==='photos') {
    const {sessions}=await request('/api/photos');
    console.log(JSON.stringify({sessions:sessions.map(session=>({id:session.id,title:session.title,status:session.status,stage:session.stage,round:session.round,
      selectionVersion:session.selectionVersion,updatedAt:session.updatedAt,error:session.error,favorites:session.selectedFrameIds.length,
      exports:session.exports.map(({version,count,sha256,url})=>({version,count,sha256,url}))}))},null,2));
  } else if(command==='photo-status') {
    if(!flags.session||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(flags.session))throw new Error('--session mit gültiger Foto-Session-ID erforderlich.');
    console.log(JSON.stringify(await request(`/api/photos/${flags.session}`),null,2));
  }
  else if(command==='tick'||command==='learn')console.log(JSON.stringify(await request('/api/content/run',{autopilot:command==='tick',learning:true,test:flags.test==='true'}),null,2));
  else if(command==='content-status') {
    const data=await request(`/api/content?test=${flags.test==='true'}`);
    console.log(JSON.stringify({accounts:data.accounts,collections:data.collections,availableCollections:data.availableCollections,concepts:data.concepts.map(({id,title,status,currentVersionId})=>({id,title,status,currentVersionId})),
      versions:data.versions.map(({id,conceptId,number,jobId,parentVersionId,renderStatus,reviewStatus,exports})=>({id,conceptId,number,jobId,parentVersionId,renderStatus,reviewStatus,exports})),
      learningRuns:data.learningRuns,learnings:data.learnings,meta:data.meta},null,2));
  } else if(command==='brief')console.log(JSON.stringify(await request(`/api/content/brief?collection=${encodeURIComponent(flags.collection||'')}&topic=${encodeURIComponent(flags.topic||'')}&test=${flags.test==='true'}`),null,2));
  else if(command==='vault-sync'||command==='knowledge-export') {
    const data=await request(`/api/content/knowledge?test=${flags.test==='true'}`),target=path.join(root,flags.test==='true'?'knowledge-test.json':'knowledge.json');
    await fs.writeFile(target,JSON.stringify(data,null,2),{mode:0o600});
    if(command==='vault-sync') {
      if(!flags.vault)throw new Error('--vault mit dem lokalen Obsidian-Vault erforderlich.');
      console.log(JSON.stringify(await syncVault(data,{vault:flags.vault}),null,2));
    } else console.log(JSON.stringify({notes:data.notes.length,revision:data.revision,path:target}));
  } else if(command==='import') {
    if(!flags.csv)throw new Error('--csv ist erforderlich.');
    console.log(JSON.stringify(await request('/api/content/imports',{csv:await fs.readFile(path.resolve(flags.csv),'utf8'),isTest:flags.test==='true'}),null,2));
  }
  else if(command==='next') {
    const {requests}=await request('/api/brain/work');
    if(flags.kind==='job') {
      const content=await request(`/api/content?test=${flags.test==='true'}`);
      const revisions=new Set(content.versions.filter(version=>version.parentVersionId).map(version=>version.jobId));
      requests.sort((a,b)=>Number(revisions.has(b.targetId))-Number(revisions.has(a.targetId)));
    }
    const item=requests.find(item=>(!flags.kind||item.kind===flags.kind)&&(!flags.id||item.id===flags.id)&&(!Object.hasOwn(flags,'test')||item.isTest===(flags.test==='true'))&&(item.status==='queued'||item.worker===worker||Date.parse(item.leaseUntil)<=Date.now()));
    if(!item){console.log(JSON.stringify({pending:false,kind:flags.kind||'any'}));}
    else {
      // Load the current local notes before claiming; an unreadable vault must not consume a lease.
      const vaultContext=flags.vault&&item.kind==='job'?await readVaultContext({vault:flags.vault}):null;
      const data=await request(`/api/brain/${item.id}/claim`,{worker});
      const dir=path.join(root,data.id);await fs.mkdir(dir,{recursive:true});const files=[],media=[];
      for(const asset of data.assets)for(let i=0;i<asset.sheetUrls.length;i++) {
        const target=path.join(dir,`${asset.id}-sheet-${i+1}.jpg`);await download(asset.sheetUrls[i],target);files.push({assetId:asset.id,path:target});
      }
      for(const asset of data.assets)if(asset.media) {
        const paths={assetId:asset.id,preview:null,audio:null,duration:asset.media.duration};
        for(const [kind,filename] of [['preview','sequence-preview.mp4'],['audio','original-audio.m4a']]) {
          if(!asset.media[kind])continue;
          if(asset.media[kind]!==filename||!asset.mediaUrls?.[kind])throw new Error('Ungültige Evidence-Mediendatei.');
          const target=path.join(dir,`${asset.id}-${filename}`);await download(asset.mediaUrls[kind],target);paths[kind]=target;
        }
        media.push(paths);
      }
      const manifestPath=path.join(dir,'manifest.json');await fs.writeFile(manifestPath,JSON.stringify(data,null,2),{mode:0o600});
      if(vaultContext)await fs.writeFile(path.join(dir,'vault-context.json'),JSON.stringify(vaultContext,null,2),{mode:0o600});
      let subjectReference=null;
      if(data.kind==='photo'&&data.subjectReference) {
        const target=path.join(dir,'subject-reference.jpg');await download(data.subjectReference.fileUrl,target);
        subjectReference={assetId:data.subjectReference.assetId,at:data.subjectReference.at,path:target};
      }
      console.log(JSON.stringify({pending:true,id:data.id,kind:data.kind,targetId:data.targetId,title:data.title,manifest:manifestPath,images:files,media,
        context:data.context,vaultContext,assets:data.assets.map(asset=>({id:asset.id,name:asset.name,duration:asset.duration,width:asset.width,height:asset.height,fps:asset.fps,error:asset.error,colorWarning:asset.colorWarning,
          audio:asset.audio,colour:asset.colour,audioInfo:asset.audioInfo,signalReview:asset.signalReview,media:asset.media,
          times:asset.times,sheetIndex:asset.sheetIndex,coverage:asset.coverage,frames:asset.frames?.map(({id,at})=>({id,at})),transcript:asset.transcript})),options:data.options,subjectReference,history:data.history},null,2));
    }
  } else {
    const data=await manifest(),endpoint=`/api/brain/${data.id}`;
    if(command==='window'||command==='window-status') {
      if(data.kind!=='photo')throw new Error('Detailfenster sind Foto-Aufträgen zugeordnet.');
      let result;
      if(command==='window')result=await request(endpoint+'/window',{token:data.token,window:{assetId:flags.asset,from:Number(flags.from),to:Number(flags.to),step:Number(flags.step)}});
      else {if(!flags.window||!/^[a-f0-9]{32}$/.test(flags.window))throw new Error('--window mit gültiger Fenster-ID erforderlich.');result=await request(`${endpoint}/window/${flags.window}`);}
      const wait=Number(flags.wait??45);if(!Number.isFinite(wait)||wait<0||wait>55)throw new Error('--wait: 0 bis 55 Sekunden.');
      const until=Date.now()+wait*1000;
      while(['queued','running'].includes(result.status)&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,2000));result=await request(`${endpoint}/window/${result.id}`);}
      const images=[],frames=[];
      if(result.status==='done') {
        for(let i=0;i<result.sheetUrls.length;i++){const target=path.join(path.dirname(path.resolve(flags.manifest)),`${result.assetId}-window-${result.id}-sheet-${i+1}.jpg`);await download(result.sheetUrls[i],target);images.push(target);}
        for(const frame of result.frames){const target=path.join(path.dirname(path.resolve(flags.manifest)),`${result.assetId}-photo-${frame.id}.jpg`);await download(frame.fileUrl,target);frames.push({id:frame.id,at:frame.at,path:target});}
      }
      console.log(JSON.stringify({windowId:result.id,assetId:result.assetId,status:result.status,processed:result.processed,requestedCount:result.requestedCount,from:result.from,to:result.to,step:result.step,error:result.error,images,frames,
        next:['queued','running'].includes(result.status)?'Mit window-status --window FENSTER-ID denselben Auftrag prüfen; nicht neu anlegen.':undefined},null,2));
    } else if(command==='frame') {
      const result=await request(endpoint+'/frame',{token:data.token,assetId:flags.asset,at:Number(flags.at)});
      const target=path.join(path.dirname(path.resolve(flags.manifest)),`${flags.asset}-detail-${String(flags.at).replace('.','_')}.jpg`);await download(result.fileUrl,target);console.log(JSON.stringify({at:result.at,path:target}));
    } else if(command==='renew')console.log(JSON.stringify(await request(endpoint+'/renew',{token:data.token})));
    else if(command==='complete') {
      if(!flags.result)throw new Error('--result ist erforderlich.');
      const result=JSON.parse(await fs.readFile(path.resolve(flags.result),'utf8'));
      console.log(JSON.stringify(await request(endpoint+'/complete',{token:data.token,result})));
    } else if(command==='fail')console.log(JSON.stringify(await request(endpoint+'/fail',{token:data.token,error:flags.reason||'Die Auswertung benötigt eine manuelle Prüfung.'})));
    else throw new Error('Befehl: status, list, catalog-status, vault-context, photos, photo-status, next, frame, window, window-status, renew, complete, fail, content-status, tick, learn, brief, import, knowledge-export oder vault-sync.');
  }
}catch(error){console.error(error.message);process.exitCode=1;}
