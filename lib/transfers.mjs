import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validId } from './store.mjs';
import { fileHash,libraryFields } from './library.mjs';

const accepted=new Set(['.mp4','.mov','.m4v','.mkv','.webm','.avi']);
const problem=(status,message)=>Object.assign(new Error(message),{status});
const retention=7*24*3600_000;

export class LibraryTransfers {
  constructor(config,library,capacity,onSaved) {
    this.config=config; this.library=library; this.capacity=capacity; this.onSaved=onSaved;
    this.root=path.join(config.dataDir,'transfers'); this.items=new Map(); this.lock=Promise.resolve();
  }
  directory(id) {
    if(!validId(id))throw problem(404,'Upload nicht gefunden.');
    return path.join(this.root,id);
  }
  part(id) { return path.join(this.directory(id),'original.part'); }
  exclusive(action) {
    const task=this.lock.catch(()=>{}).then(action);this.lock=task.catch(()=>{});return task;
  }
  async initialize() {
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    for(const id of await fs.readdir(this.root)) {
      if(!validId(id))continue;
      let item;
      try {item=JSON.parse(await fs.readFile(path.join(this.directory(id),'transfer.json'),'utf8'));}
      catch {continue;}
      if(item.id!==id||!Number.isSafeInteger(item.size)||!Number.isSafeInteger(item.offset)||item.offset<0||item.offset>item.size)continue;
      if(Date.now()-Date.parse(item.updatedAt)>retention) {
        await fs.rm(this.directory(id),{recursive:true,force:true});continue;
      }
      if(item.status==='uploading') {
        try {
          const info=await fs.stat(this.part(id));
          if(info.size<item.offset) {item.offset=0;item.lastChunk=null;}
          await fs.truncate(this.part(id),item.offset);
        } catch(error) {if(error.code!=='ENOENT')throw error;continue;}
      }
      this.items.set(id,item);
    }
  }
  reserved(except) {
    return [...this.items.values()].filter(item=>item.status==='uploading'&&item.id!==except&&Date.now()-Date.parse(item.updatedAt)<=retention)
      .reduce((sum,item)=>({remaining:sum.remaining+item.size-item.offset,total:sum.total+item.size}),{remaining:0,total:0});
  }
  async cleanExpired() {
    for(const item of this.items.values())if(Date.now()-Date.parse(item.updatedAt)>retention) {
      await fs.rm(this.directory(item.id),{recursive:true,force:true});this.items.delete(item.id);
    }
  }
  async persist(item) {
    const directory=this.directory(item.id);await fs.mkdir(directory,{recursive:true,mode:0o700});
    const temp=path.join(directory,`record-${randomUUID()}.tmp`);
    await fs.writeFile(temp,JSON.stringify(item),{mode:0o600});await fs.rename(temp,path.join(directory,'transfer.json'));
    this.items.set(item.id,item);return item;
  }
  get(id) {this.directory(id);const item=this.items.get(id);if(!item||(item.status==='uploading'&&Date.now()-Date.parse(item.updatedAt)>retention))throw problem(404,'Upload nicht gefunden oder abgelaufen. Bitte die Datei erneut auswählen.');return item;}
  public(item) {
    const result={id:item.id,name:item.name,size:item.size,offset:item.offset,status:item.status,
      chunkBytes:this.config.uploadChunkBytes,lastChunk:item.lastChunk||null,expiresAfterDays:7};
    if(item.status==='complete')Object.assign(result,{clip:this.library.public(this.library.get(item.clipId)),duplicate:item.duplicate});
    return result;
  }
  async start(input) {return this.exclusive(async()=>{
    await this.cleanExpired();
    const key=input?.key,name=typeof input?.name==='string'?input.name.replace(/\\/g,'/').split('/').pop().replace(/[\u0000-\u001f]/g,'').slice(0,180):'';
    if(typeof key!=='string'||! /^[a-f0-9]{64}$/.test(key)||!name||!accepted.has(path.extname(name).toLowerCase()))throw problem(400,'Bitte eine Videoaufnahme als MP4, MOV, M4V, MKV, WEBM oder AVI auswählen.');
    const size=input.size;
    if(!Number.isSafeInteger(size)||size<=0||size>this.config.maxFileBytes)throw problem(413,`Eine Aufnahme darf bis zu ${(this.config.maxFileBytes/1024**3).toFixed(0)} GB groß sein.`);
    const fields=input.fields||{};try{libraryFields(fields);}catch(error){throw problem(400,error.message);}
    const previous=[...this.items.values()].find(item=>item.key===key&&item.name===name&&item.size===size);
    if(previous) {
      if(previous.status==='complete') {
        await this.library.adopt(this.library.get(previous.clipId),fields);
        return {...this.public(previous),duplicate:true};
      }
      if(previous.status==='uploading')await this.persist({...previous,fields,updatedAt:new Date().toISOString()});
      return this.public(this.get(previous.id));
    }
    if([...this.items.values()].filter(item=>item.status==='uploading').length>=64)throw problem(429,'Zu viele unterbrochene Uploads. Bitte zuerst vorhandene Uploads fortsetzen.');
    await this.capacity.require(size,this.reserved());
    const id=randomUUID(),now=new Date().toISOString();
    await fs.mkdir(this.directory(id),{recursive:true,mode:0o700});
    await fs.writeFile(this.part(id),'',{flag:'wx',mode:0o600});
    return this.public(await this.persist({id,key,name,size,fields,offset:0,status:'uploading',createdAt:now,updatedAt:now,lastChunk:null}));
  });}
  async append(id,offset,length,checksum,req) {return this.exclusive(async()=>{
    const item=this.get(id);
    if(item.status!=='uploading'||offset!==item.offset)throw problem(409,'Der Upload-Stand hat sich geändert. Bitte den bestätigten Stand abrufen.');
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||length<=0||length>this.config.uploadChunkBytes||offset+length>item.size||! /^[a-f0-9]{64}$/.test(checksum||''))throw problem(400,'Ungültiger Upload-Teil.');
    if(req.headers['content-type']!=='application/octet-stream')throw problem(400,'Ungültiges Upload-Format.');
    if(req.headers['content-length']&&Number(req.headers['content-length'])!==length)throw problem(400,'Die Größe des Upload-Teils stimmt nicht.');
    const reserved=this.reserved(id);
    await this.capacity.require(item.size-item.offset,{remaining:reserved.remaining,total:reserved.total+item.offset});
    await fs.truncate(this.part(id),offset);
    const hash=createHash('sha256');let bytes=0;
    const counter=new Transform({transform(chunk,encoding,callback){
      bytes+=chunk.length;if(bytes>length)return callback(problem(413,'Upload-Teil zu groß.'));
      hash.update(chunk);callback(null,chunk);
    }});
    try {
      await pipeline(req,counter,createWriteStream(this.part(id),{flags:'r+',start:offset}));
      if(bytes!==length||hash.digest('hex')!==checksum)throw problem(400,'Der Upload-Teil wurde nicht vollständig oder unverändert übertragen.');
      const saved=await this.persist({...item,offset:offset+length,updatedAt:new Date().toISOString(),lastChunk:{offset,length,sha256:checksum}});
      return this.public(saved);
    } catch(error) {await fs.truncate(this.part(id),offset);throw error;}
  });}
  async finish(id) {return this.exclusive(async()=>{
    const item=this.get(id);if(item.status==='complete')return this.public(item);
    if(item.offset!==item.size)throw problem(409,'Die Aufnahme ist noch nicht vollständig hochgeladen.');
    const source={id:item.id,name:item.name,size:item.size,path:this.part(id),sha256:await fileHash(this.part(id))};
    const result=await this.library.adopt(source,item.fields);
    const completed=await this.persist({...item,status:'complete',clipId:result.clip.id,duplicate:result.duplicate,updatedAt:new Date().toISOString()});
    if(result.clip.status==='queued')this.onSaved(result.clip.id);
    await fs.unlink(this.part(id)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    return this.public(completed);
  });}
  async discard(id) {return this.exclusive(async()=>{
    const item=this.get(id);if(item.status!=='uploading')throw problem(409,'Eine gespeicherte Originalaufnahme kann hier nicht gelöscht werden.');
    await fs.rm(this.directory(id),{recursive:true,force:true});this.items.delete(id);return {ok:true};
  });}
}
