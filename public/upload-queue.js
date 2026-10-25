import { uploadMany } from './uploads.js';

// The queue belongs to the studio page, never to an upload dialog or view.
export class UploadQueue {
  constructor({ upload=uploadMany, id=()=>crypto.randomUUID() }={}) {
    this.upload=upload; this.id=id; this.tasks=[]; this.listeners=new Set(); this.active=null;
  }
  subscribe(listener) { this.listeners.add(listener); listener(this.list()); return ()=>this.listeners.delete(listener); }
  list() { return this.tasks.map(task=>this.snapshot(task)); }
  snapshot(task) {
    const files=task.files.map(item=>({name:item.name,size:item.size,loaded:item.loaded,status:item.status,error:item.error}));
    const total=files.reduce((sum,item)=>sum+item.size,0), loaded=files.reduce((sum,item)=>sum+item.loaded,0);
    return {id:task.id,label:task.label,kind:task.kind,status:task.status,stage:task.stage,error:task.error,
      files,total,loaded,percent:total?Math.min(100,Math.round(loaded/total*100)):task.status==='done'?100:0,
      saved:task.files.filter(item=>item.clip).length,duplicates:task.files.filter(item=>item.duplicate).length,
      result:task.result,createdAt:task.createdAt};
  }
  changed(task,event='change') {
    const snapshot=task&&this.snapshot(task);
    for(const listener of this.listeners) listener(this.list(),{event,task:snapshot});
  }
  enqueue({files=[],clips=[],fields={},kind='library',label='Aufnahmen ablegen',afterUpload}={}) {
    if(!files.length&&!clips.length) throw new Error('Wähle zuerst Videoaufnahmen aus.');
    const task={id:this.id(),kind,label,fields:{...fields},existingClips:[...clips],afterUpload,
      files:[...files].map(file=>({file,name:file.name,size:file.size,loaded:0,status:'Bereit',clip:null})),
      status:'queued',stage:'Wartet auf den Upload',error:'',result:null,createdAt:new Date().toISOString()};
    this.tasks.push(task); this.changed(task,'queued'); void this.drain(); return task.id;
  }
  pause(id) {
    const task=this.tasks.find(item=>item.id===id); if(!task||!['queued','running'].includes(task.status))return;
    task.status=task===this.active?'pausing':'paused'; task.stage='Upload pausiert';
    task.controller?.abort(); this.changed(task);
  }
  resume(id) {
    const task=this.tasks.find(item=>item.id===id); if(!task||!['paused','error'].includes(task.status))return;
    task.status='queued';task.error='';task.stage='Wartet auf Fortsetzung';
    for(const item of task.files)if(!item.clip){item.error='';item.status='Wird fortgesetzt';}
    this.changed(task);void this.drain();
  }
  cancel(id) {
    const task=this.tasks.find(item=>item.id===id);if(!task||!['queued','running','paused','error'].includes(task.status))return;
    task.status='cancelled';task.stage='Beendet · gespeicherte Originale bleiben erhalten';task.controller?.abort();
    if(task!==this.active)this.release(task);this.changed(task);void this.drain();
  }
  dismiss(id) {
    const task=this.tasks.find(item=>item.id===id);if(!task||!['done','cancelled'].includes(task.status))return;
    this.tasks=this.tasks.filter(item=>item!==task);this.changed();
  }
  hasUnfinished() { return this.tasks.some(task=>!['done','cancelled'].includes(task.status)); }
  release(task) { for(const item of task.files)item.file=null;task.afterUpload=null; }
  async drain() {
    if(this.active)return;
    const task=this.tasks.find(item=>item.status==='queued');if(!task)return;
    this.active=task;task.status='running';task.controller=new AbortController();this.changed(task);
    try {
      const pending=task.files.filter(item=>!item.clip);
      if(pending.length) {
        const result=await this.upload(pending.map(item=>item.file),{
          fields:task.fields,signal:task.controller.signal,
          onProgress:info=>{
            const item=pending[info.index];
            // uploadMany reports completed bytes plus the current file offset.
            const finished=pending.slice(0,info.index).filter(entry=>entry.clip).reduce((sum,entry)=>sum+entry.size,0);
            item.loaded=item.clip?item.size:Math.min(item.size,Math.max(0,info.loaded-finished));
            item.status=info.stage;task.stage=`${info.file.name} · ${info.stage}`;this.changed(task);
          },
          onSaved:info=>{
            const item=pending[info.index];Object.assign(item,{clip:info.clip,duplicate:info.duplicate,loaded:item.size,
              status:info.duplicate?'Bereits vorhanden':'Gespeichert',error:''});this.changed(task,'saved');
          },
          onProblem:info=>{
            const item=pending[info.index];item.error=info.error.message;item.status='Bitte prüfen';this.changed(task,'problem');
          }
        });
        if(result.failures.length||task.files.some(item=>!item.clip)) {
          throw new Error(result.failures.map(item=>`${item.name}: ${item.error}`).join(' · ')||'Einige Dateien sind noch offen. Fortsetzen lädt am bestätigten Stand weiter.');
        }
      }
      if(task.controller.signal.aborted||task.status==='cancelled')throw new DOMException('Upload pausiert.','AbortError');
      const clips=[...new Map([...task.existingClips,...task.files.map(item=>item.clip)].map(clip=>[clip.id,clip])).values()];
      if(task.afterUpload) {task.status='completing';task.stage='Originale gespeichert · Schnittauftrag wird bestätigt';this.changed(task);}
      task.result=task.afterUpload?await task.afterUpload({id:task.id,clips}):{clips};
      task.status='done';task.stage=task.kind==='reel'?'Schnittauftrag angelegt':'Originale gespeichert · Vorbereitung folgt';
      task.error='';this.release(task);this.changed(task,'done');
    } catch(error) {
      if(task.status==='cancelled')this.release(task);
      else if(task.controller.signal.aborted||error.name==='AbortError') {
        task.status='paused';task.stage='Upload pausiert · bestätigte Teile bleiben gespeichert';
        for(const item of task.files)if(!item.clip&&!item.error)item.status='Pausiert';
      } else {task.status='error';task.error=error.message;task.stage='Bitte prüfen und fortsetzen';}
      this.changed(task,'stopped');
    } finally {task.controller=null;this.active=null;void this.drain();}
  }
}

export const uploadQueue=new UploadQueue();
