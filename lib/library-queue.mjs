import fs from 'node:fs/promises';
import path from 'node:path';
import { probe, createProxy } from './media.mjs';
import { run } from './process.mjs';
import { catalogWithGemini, inferCatalog } from './catalog.mjs';

export class LibraryQueue {
  constructor(library,config,serial,{cataloger=catalogWithGemini,brain}={}) {
    this.library=library; this.config=config; this.serial=serial; this.cataloger=cataloger;
    this.brain=brain;
    this.waiting=[]; this.running=null; this.closing=false; this.controller=null;
  }
  enqueue(id) {
    if(this.running===id || this.waiting.includes(id) || this.closing) return;
    this.waiting.push(id); setImmediate(()=>this.drain());
  }
  async drain() {
    if(this.running || this.closing || !this.waiting.length) return;
    const id=this.waiting.shift(); if(!this.library.get(id)) return this.drain();
    this.running=id; this.controller=new AbortController();
    try { await this.process(id,this.controller.signal); }
    catch(error) {
      const clip=this.library.get(id);
      const resuming=this.closing&&this.controller.signal.aborted;
      if(!this.controller.signal.aborted) console.error(`Bibliothek ${id}:`,error.message);
      await this.library.update(id,{status:resuming?'queued':clip.previewReady?'ready':'error',analysisStatus:this.controller.signal.aborted?'interrupted':'error',
        error:resuming||clip.previewReady?null:'Diese Aufnahme konnte nicht vorbereitet werden. Format und Datei prüfen.',
        analysisError:!resuming&&clip.previewReady?'Die Inhaltssortierung wurde nicht abgeschlossen. Bitte erneut einsortieren.':null,
        stage:resuming?'Gespeichert · wird nach Serverneustart fortgesetzt.':clip.previewReady?'Gespeichert · Inhaltssortierung offen.':'Vorbereitung fehlgeschlagen.'});
    } finally { this.running=null; this.controller=null; if(!this.closing) setImmediate(()=>this.drain()); }
  }
  async process(id,signal) {
    let clip=this.library.get(id); const config=this.config, dir=this.library.directory(id);
    await this.library.update(id,{status:'processing',stage:'Aufnahme wird vorbereitet.',error:null,analysisError:null});
    const info=await this.serial.run(()=>probe(clip.path,config,signal),signal);
    if(info.duration>config.maxSourceSeconds || info.width>8192 || info.height>8192) throw new Error('Aufnahmelänge oder Auflösung überschreitet das Limit.');
    if(!clip.previewReady) {
      if(this.brain?.previewPriorityWaiting?.()){
        await this.library.update(id,{stage:'Reel-Auftrag hat Vorrang · danach wird die Vorschau erstellt.'});
        while(this.brain.previewPriorityWaiting()) {signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,250));}
        signal.throwIfAborted();
      }
      await this.serial.run(()=>createProxy({...clip,...info},path.join(dir,'preview-tmp.mp4'),config,signal),signal);
      await this.serial.run(()=>run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1',
        '-ss',String(Math.min(1,info.duration/3)),'-i',path.join(dir,'preview-tmp.mp4'),'-frames:v','1','-q:v','3',path.join(dir,'poster-tmp.jpg')],{signal,timeout:30_000}),signal);
      await fs.rename(path.join(dir,'preview-tmp.mp4'),path.join(dir,'preview.mp4'));
      await fs.rename(path.join(dir,'poster-tmp.jpg'),path.join(dir,'poster.jpg'));
    }
    clip=await this.library.update(id,{...info,previewReady:true,
      ...(['ai','codex'].includes(clip.classificationSource)?{}:inferCatalog(clip.name,`${clip.collections.join(' ')} ${clip.context}`)),
      stage:config.analysisProvider==='codex'?'Bildfolgen für Codex werden vorbereitet.':config.apiKey?'Die Aufnahme wird inhaltlich einsortiert.':'Gespeichert · nach Dateiname und Kontext eingeordnet.',
      analysisStatus:config.analysisProvider==='codex'?'preparing-codex':config.apiKey?'processing':'needs-key'});
    if(config.analysisProvider==='codex') {
      await this.brain.prepareClip(clip,signal);
      await this.library.update(id,{status:'ready',analysisStatus:'waiting-codex',stage:'Gespeichert · wartet auf Codex-Auswertung.'});
    } else if(config.apiKey) {
      const catalog=await this.serial.run(()=>this.cataloger(clip,path.join(dir,'preview.mp4'),config,signal,
        stage=>this.library.update(id,{stage})),signal);
      await this.library.update(id,{...catalog,status:'ready',classificationSource:'ai',analysisStatus:'done',
        providerCleanupWarning:catalog.cleanup?.some(file=>!file.deleted)||false,stage:'Gespeichert und inhaltlich einsortiert.'});
    } else await this.library.update(id,{status:'ready'});
  }
  async close() {
    this.closing=true; this.controller?.abort();
    const deadline=Date.now()+20_000;
    while(this.running && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
  }
}
