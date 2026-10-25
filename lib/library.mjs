import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { validId } from './store.mjs';
import { inferCatalog, categoryIds, cleanText, cleanTags } from './catalog.mjs';

const extensions = new Set(['.mp4','.mov','.m4v','.mkv','.webm','.avi']);
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function linkOriginal(source, target) {
  try { await fs.link(source,target); }
  catch (error) { if (error.code !== 'EXDEV') throw error; await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL); }
}
export function libraryFields(fields) {
  const collection = cleanText(fields.collection ?? fields.title ?? '',80,'Sammlung') || 'Ohne Sammlung';
  const context = cleanText(fields.brief ?? '',1600,'Kontext');
  const recordedAt = cleanText(fields.recordedAt ?? '',10,'Aufnahmedatum');
  if (recordedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(recordedAt) || !Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString().slice(0,10)!==recordedAt)) throw new Error('Bitte ein gültiges Aufnahmedatum wählen.');
  return {collection,context,recordedAt};
}

export class MediaLibrary {
  constructor(dataRoot) { this.dataRoot=path.resolve(dataRoot); this.root=path.join(this.dataRoot,'library'); this.items=new Map(); this.hashes=new Map(); this.writes=new Map(); this.adoptions=new Map(); }
  directory(id) { if(!validId(id)) throw new Error('Ungültige Footage-Referenz.'); return path.join(this.root,id); }
  async initialize() {
    await fs.mkdir(this.root,{recursive:true});
    for (const id of await fs.readdir(this.root)) {
      if(!validId(id)) continue;
      try {
        const clip=JSON.parse(await fs.readFile(path.join(this.directory(id),'clip.json'),'utf8'));
        if(clip.id!==id || !extensions.has(clip.extension)) continue;
        clip.path=path.join(this.directory(id),`original${clip.extension}`);
        await fs.access(clip.path); this.items.set(id,clip);
        if(clip.sha256) this.hashes.set(clip.sha256,id);
        if(clip.status==='processing') await this.update(id,{status:clip.previewReady?'ready':'error',analysisStatus:'interrupted',stage:'Durch Neustart unterbrochen. Bitte erneut einsortieren.',error:clip.previewReady?null:'Vorschau unterbrochen. Bitte erneut vorbereiten.'});
      } catch { /* A broken index must not expose arbitrary paths or stop other clips. */ }
    }
  }
  get(id) { return this.items.get(id); }
  list() { return [...this.items.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  bytes() { return this.list().reduce((sum,item)=>sum+item.size,0); }
  async save(clip) {
    const dir=this.directory(clip.id); await fs.mkdir(dir,{recursive:true});
    const temp=path.join(dir,`clip-${randomUUID()}.tmp`);
    const {path:privatePath,...saved}=clip;
    await fs.writeFile(temp,JSON.stringify(saved,null,2),{mode:0o600}); await fs.rename(temp,path.join(dir,'clip.json'));
  }
  update(id,changes) {
    const previous=this.writes.get(id) || Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const clip=this.get(id); if(!clip) throw new Error('Aufnahme nicht gefunden.');
      const next={...clip,...(typeof changes==='function'?changes(clip):changes),updatedAt:new Date().toISOString()};
      await this.save(next); this.items.set(id,next); return next;
    });
    this.writes.set(id,task);
    task.finally(()=>{if(this.writes.get(id)===task)this.writes.delete(id);}).catch(()=>{});
    return task;
  }
  async adopt(source,fields={}) {
    const options=libraryFields(fields);
    const extension=path.extname(source.name).toLowerCase();
    if(!extensions.has(extension)) throw new Error('Das Videoformat wird nicht unterstützt.');
    const sha256=source.sha256 || await fileHash(source.path);
    // Keep the content check and publication together across every upload path.
    const previous=this.adoptions.get(sha256)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      const match=this.get(this.hashes.get(sha256));
      if(match) {
        const collections=[...new Set([...match.collections,options.collection])];
        const changes={collections};
        if(match.category==='unsortiert' && !['ai','codex'].includes(match.classificationSource)) Object.assign(changes,inferCatalog(match.name,`${collections.join(' ')} ${options.context}`));
        if(!match.context && options.context) changes.context=options.context;
        if(!match.recordedAt && options.recordedAt) changes.recordedAt=options.recordedAt;
        const clip=await this.update(match.id,changes); return {clip,duplicate:true};
      }
      const id=validId(source.id) && !this.get(source.id)?source.id:randomUUID();
      const dir=this.directory(id); await fs.mkdir(dir,{recursive:true});
      const original=path.join(dir,`original${extension}`);
      await linkOriginal(source.path,original);
      const now=new Date().toISOString();
      const clip={id,name:source.name,extension,path:original,sha256,size:source.size,createdAt:now,updatedAt:now,
        collections:[options.collection],context:options.context,recordedAt:options.recordedAt,
        ...inferCatalog(source.name,`${options.collection} ${options.context}`),classificationSource:'filename',
        overrides:{},favorite:false,archived:false,status:'queued',stage:'Vorschau und Metadaten werden vorbereitet.',
        analysisStatus:'pending',previewReady:false,error:null};
      try { await this.save(clip); } catch(error) { await fs.rm(dir,{recursive:true,force:true}); throw error; }
      this.items.set(id,clip); this.hashes.set(sha256,id); return {clip,duplicate:false};
    });
    this.adoptions.set(sha256,task);
    task.finally(()=>{if(this.adoptions.get(sha256)===task)this.adoptions.delete(sha256);}).catch(()=>{});
    return task;
  }
  async importJobs(store) {
    const queued=[];
    for (const job of store.list()) {
      let changed=false; const assets=[];
      for (const asset of job.assets) {
        if(asset.libraryId && this.get(asset.libraryId)) { assets.push(asset); continue; }
        if(!asset.path || !path.resolve(asset.path).startsWith(this.dataRoot+path.sep)) { assets.push(asset); continue; }
        try {
          await fs.access(asset.path);
          const result=await this.adopt(asset,{collection:job.title || 'Frühere Session',brief:job.options?.brief || ''});
          assets.push({...asset,libraryId:result.clip.id}); changed=true;
          if(!result.duplicate) queued.push(result.clip.id);
        } catch(error) { assets.push(asset); console.error(`Footage-Import ${job.id}:`,error.code || 'nicht lesbar'); }
      }
      if(changed) await store.update(job.id,{assets});
    }
    return queued;
  }
  async edit(id,fields) {
    if(!fields || typeof fields!=='object' || Array.isArray(fields)) throw new Error('Ungültige Änderung.');
    const changes={}, overrides={};
    if(Object.hasOwn(fields,'title')) overrides.title=cleanText(fields.title,100,'Titel',true);
    if(Object.hasOwn(fields,'category')) { if(!categoryIds.has(fields.category)) throw new Error('Ungültiges Thema.'); overrides.category=fields.category; }
    if(Object.hasOwn(fields,'tags')) overrides.tags=cleanTags(fields.tags);
    if(Object.hasOwn(fields,'note')) changes.note=cleanText(fields.note,1600,'Notiz');
    if(Object.hasOwn(fields,'collections')) {
      if(!Array.isArray(fields.collections)||!fields.collections.length||fields.collections.length>12) throw new Error('Bitte eine bis zwölf Sammlungen wählen.');
      changes.collections=[...new Set(fields.collections.map(value=>cleanText(value,80,'Sammlung',true)))];
    }
    if(Object.hasOwn(fields,'recordedAt')) changes.recordedAt=libraryFields({recordedAt:fields.recordedAt}).recordedAt;
    for(const key of ['favorite','archived']) if(Object.hasOwn(fields,key)) { if(typeof fields[key]!=='boolean') throw new Error('Ungültige Auswahl.'); changes[key]=fields[key]; }
    return this.update(id,current=>({...changes,overrides:{...current.overrides,...overrides}}));
  }
  public(clip) {
    const {path:privatePath,sha256,extension,context,provider,model,usage,...safe}=clip;
    return {...safe,...clip.overrides,reference:`footage:${clip.id}`,categoryManual:Boolean(clip.overrides?.category),
      originalUrl:`/api/library/${clip.id}/files/original`,
      previewUrl:clip.previewReady?`/api/library/${clip.id}/files/preview`:null,
      posterUrl:clip.previewReady?`/api/library/${clip.id}/files/poster`:null};
  }
}
