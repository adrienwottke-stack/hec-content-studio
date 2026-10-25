import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { getStyleProfile } from './style-profiles.mjs';
import { inspectSignals } from './media-quality.mjs';
import { timecodeOverlay } from './fonts.mjs';

const transcriber=fileURLToPath(new URL('../scripts/transcribe-local.py',import.meta.url));
export function sampleTimes(duration,{styleProfile}={}) {
  const maximum=getStyleProfile(styleProfile).id==='late-night-drive'?96:32;
  const count=Math.min(maximum,Math.max(2,Math.ceil(duration*2)+1));
  return Array.from({length:count},(_,i)=>Math.round((duration-0.08)*i/(count-1)*1000)/1000).filter(time=>time>=0);
}
export async function extractFrame(asset,at,target,config,signal,{thumbnail=false,square=false}={}) {
  const width=square?480:384,height=square?480:216;
  const label=thumbnail?await timecodeOverlay(at):'';
  const filter=thumbnail?`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x152336${label}`:'scale=1280:1280:force_original_aspect_ratio=decrease';
  await run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-ss',String(at),'-i',asset.path,
    '-frames:v','1','-filter_threads','1','-vf',filter,'-q:v','3',target],{signal,timeout:45_000});
}
export async function prepareEvidence(asset,directory,config,signal,{serial,styleProfile}={}) {
  const perform=task=>serial?serial.run(task,signal):task();
  const drive=getStyleProfile(styleProfile).id==='late-night-drive';
  await fs.mkdir(directory,{recursive:true});
  // Decode the actual source before describing any signal inspection as passed.
  const signalReview=drive?await perform(()=>inspectSignals(asset.path,asset,config,signal)):null;
  const times=sampleTimes(asset.duration,{styleProfile});
  for(let i=0;i<times.length;i++) await perform(()=>extractFrame(asset,times[i],path.join(directory,`frame-${String(i+1).padStart(3,'0')}.jpg`),config,signal,{thumbnail:true,square:drive}));
  await perform(()=>run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-framerate','1',
    '-i',path.join(directory,'frame-%03d.jpg'),'-vf','tile=4x4:nb_frames=16:padding=4:margin=4:color=0x152336',
    '-fps_mode','vfr','-q:v','3',path.join(directory,'sheet-%03d.jpg')],{signal,timeout:60_000}));
  const sheets=(await fs.readdir(directory)).filter(name=>/^sheet-\d{3}\.jpg$/.test(name)).sort();
  if(!sheets.length) throw new Error('Keine Bildfolge für Codex erstellt.');
  let media;
  if(drive) {
    const preview='sequence-preview.mp4',audio=asset.audio?'original-audio.m4a':null;
    const previewFps=Number.isFinite(asset.fps)&&asset.fps>0?Math.min(24,asset.fps):24;
    const args=['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-i',asset.path,
      '-map','0:v:0','-map','0:a:0?','-vf',`scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=${previewFps}`,
      '-c:v','libx264','-threads','1','-preset','veryfast','-crf','27','-pix_fmt','yuv420p',
      '-c:a','aac','-b:a','160k','-ac','2','-map_metadata','-1','-movflags','+faststart',path.join(directory,preview)];
    await perform(()=>run(config.ffmpeg,args,{signal,timeout:600_000}));
    if(audio)await perform(()=>run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-i',asset.path,
      '-map','0:a:0','-vn','-c:a','aac','-b:a','192k','-ac','2','-map_metadata','-1','-movflags','+faststart',path.join(directory,audio)],{signal,timeout:600_000}));
    media={preview,audio,duration:asset.duration,timebase:'source-seconds',previewFps,audioChannels:asset.audio?2:0,
      notice:'Komprimierte vollständige Quelle mit unveränderter Zeitbasis und gegebenenfalls Stereo-Originalton. Keine Farbkorrektur, Aufhellung, Rauschminderung oder Klangnormalisierung; Kompression und Vorschauauflösung begrenzen die Beurteilung. Bereitgestellt bedeutet weder gesehen noch angehört.'};
  }
  let transcript={status:asset.audio?'unavailable':'no-audio',text:'',segments:[],notice:asset.audio?'Lokale Spracherkennung ist nicht verfügbar. Keine Dialoge aus Bildern ableiten.':'Die Quelle hat keine Tonspur.'};
  if(asset.audio) {
    const wave=path.join(directory,'audio.wav');
    try {
      await fs.access(config.asrModelDir);
      await perform(()=>run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-i',asset.path,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wave],{signal,timeout:90_000}));
      const result=await perform(()=>run(config.asrPython,[transcriber,config.asrModelDir,wave],{signal,timeout:600_000}));
      transcript={...JSON.parse(result.stdout),notice:'Unbestätigte lokale deutsche Spracherkennung. Wörter und Zeitmarken können falsch sein; keine wörtlichen Zitate oder Behauptungen allein darauf stützen.'};
    } catch(error) { if(signal?.aborted) throw error; }
    finally {await fs.rm(wave,{force:true});}
  }
  const sheetIndex=sheets.map((sheet,index)=>({sheet,cells:times.slice(index*16,(index+1)*16).map((at,cell)=>({row:Math.floor(cell/4)+1,column:cell%4+1,at,frame:`frame-${String(index*16+cell+1).padStart(3,'0')}.jpg`}))}));
  return {times,sheets,sheetIndex,transcript,...(drive?{media,signalReview}:{}),coverage:{type:'sampled-frames',frameCount:times.length,maxGapSeconds:times.length>1?Math.max(...times.slice(1).map((time,i)=>Math.round((time-times[i])*1000)/1000)):0,
    notice:drive?'Bis zu 96 Bildstichproben über die gesamte Quelle, keine lückenlose Videosichtung. Bewegung, präzise Schnittgrenzen und Klang zusätzlich an der bereitgestellten Sequenz prüfen; Sichtungs- und Hörumfang ehrlich festhalten.':'Stichproben aus der Quelle, keine lückenlose Videosichtung. Für kurze Aktionen und genaue Schnittmarken zusätzliche Einzelbilder anfordern.'}};
}
