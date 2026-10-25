import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { run } from './process.mjs';
import { photoLimits } from './photo-review.mjs';
import { timecodeOverlay } from './fonts.mjs';

export function photoSampleTimes(duration,assetCount) {
  const count=Math.min(photoLimits.overviewPerAsset,Math.floor(photoLimits.overviewPerSession/assetCount),Math.max(2,Math.ceil(duration/2)+1));
  return Array.from({length:count},(_,i)=>Math.round(Math.max(0,duration-0.08)*i/(count-1)*1e6)/1e6);
}
export async function photoMetadata(source,config,signal) {
  const result=await run(config.ffprobe,['-v','error','-show_streams','-show_format','-of','json',source.path],{signal,timeout:30_000});
  const data=JSON.parse(result.stdout),video=data.streams?.find(item=>item.codec_type==='video'&&!item.disposition?.attached_pic);
  const duration=Number(video?.duration??data.format?.duration);
  if(!video||!Number.isFinite(duration)||duration<0.04||!video.width||!video.height||video.width>8192||video.height>8192)throw new Error('Keine geeignete echte Videospur für Fotos.');
  const rotation=Number(video.side_data_list?.find(item=>item.rotation!==undefined)?.rotation||video.tags?.rotate||0),rotated=Math.abs(rotation%180)===90;
  const [num,den]=String(video.avg_frame_rate||'0/1').split('/').map(Number),fps=den?num/den:0;
  const hdr=['smpte2084','arib-std-b67'].includes(video.color_transfer);
  return {duration,width:rotated?video.height:video.width,height:rotated?video.width:video.height,
    streamIndex:video.index,codec:video.codec_name,rotation,fps,frameRate:video.avg_frame_rate,timeBase:video.time_base,
    timelineStart:Number(data.format?.start_time||0),color:{space:video.color_space||'unknown',transfer:video.color_transfer||'unknown',primaries:video.color_primaries||'unknown',range:video.color_range||'unknown'},
    colorWarning:hdr?'HDR-Quelle: V1 führt keine bestätigte HDR-zu-SDR-Korrektur aus. Darstellung vor Verwendung prüfen.':!video.color_transfer||video.color_transfer==='unknown'?'Farbprofil ist unbestätigt; Darstellung vor Verwendung prüfen.':''};
}
async function decodeFrame(asset,at,target,config,signal,native=false) {
  const filters=['showinfo'];if(!native)filters.push('scale=720:1280:force_original_aspect_ratio=decrease');
  const output=await run(config.ffmpeg,['-hide_banner','-loglevel','info','-nostdin','-y','-threads','1','-ss',String(at),'-copyts','-i',asset.path,
    '-map',`0:${asset.streamIndex}`,'-an','-sn','-dn','-frames:v','1','-filter_threads','1','-vf',filters.join(','),
    '-map_metadata','-1','-q:v','2','-update','1',target],{signal,timeout:60_000});
  const match=output.stderr.match(/\bn:\s*0\s+pts:\s*(-?\d+)\s+pts_time:\s*([-+\d.eE]+).*?checksum:([A-F0-9]+)/);
  if(!match)throw new Error('Die tatsächliche Decoder-Zeitmarke konnte nicht bestätigt werden.');
  const actual=Math.round((Number(match[2])-asset.timelineStart)*1e6)/1e6;
  if(actual<0||actual>asset.duration+0.001)throw new Error('Decoder-Bild außerhalb der Videospur.');
  const timeBase=output.stderr.match(/config in time_base:\s*(\d+\/\d+)/)?.[1]||asset.timeBase;
  return {at:actual,pts:match[1],timeBase,decoderChecksum:match[3]};
}
export async function extractPhotoPreview(asset,at,directory,config,signal) {
  await fs.mkdir(directory,{recursive:true});const temp=path.join(directory,`${randomUUID()}.jpg`);
  try {
    const decoded=await decodeFrame(asset,at,temp,config,signal);
    const id=createHash('sha256').update(`${asset.sha256}:${asset.id}:${asset.streamIndex}:${decoded.pts}:${decoded.timeBase}`).digest('hex').slice(0,32),filename=`frame-${id}.jpg`;
    await fs.rename(temp,path.join(directory,filename));
    return {id,assetId:asset.id,requestedAt:at,...decoded,filename};
  } finally {await fs.rm(temp,{force:true});}
}
export async function makePhotoSheets(asset,frames,directory,key,config,signal) {
  const portrait=asset.width<asset.height,w=portrait?240:320,h=portrait?426:180,perSheet=12,sheets=[];
  for(let offset=0;offset<frames.length;offset+=perSheet) {
    signal?.throwIfAborted();const items=frames.slice(offset,offset+perSheet),temp=path.join(directory,`tiles-${randomUUID()}`);await fs.mkdir(temp,{recursive:true});
    try {
      for(let i=0;i<items.length;i++) {
        const frame=items[i],label=await timecodeOverlay(frame.at,{x:5,y:5});
        await run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-i',path.join(directory,frame.filename),'-frames:v','1','-filter_threads','1',
          '-vf',`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x152336${label}`,
          '-q:v','3','-update','1',path.join(temp,`tile-${String(i+1).padStart(3,'0')}.jpg`)],{signal,timeout:20_000});
      }
      const name=`sheet-${key}-${String(offset/perSheet+1).padStart(3,'0')}.jpg`;
      await run(config.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-filter_threads','1','-framerate','1','-i',path.join(temp,'tile-%03d.jpg'),
        '-vf',`tile=4x3:nb_frames=${items.length}:padding=4:margin=4:color=0x152336`,'-frames:v','1','-q:v','3','-update','1',path.join(directory,name)],{signal,timeout:30_000});sheets.push(name);
    } finally {await fs.rm(temp,{recursive:true,force:true});}
  }
  return sheets;
}
export async function verifyPhotoImage(file,expected,config,signal) {
  const result=await run(config.ffprobe,['-v','error','-show_streams','-of','json',file],{signal,timeout:20_000});
  const image=JSON.parse(result.stdout).streams?.find(item=>item.codec_type==='video');
  if(!image||image.codec_name!=='mjpeg'||image.width!==expected.width||image.height!==expected.height)throw new Error('Foto hat nicht die bestätigten nativen Bildabmessungen.');
  await run(config.ffmpeg,['-hide_banner','-loglevel','error','-xerror','-nostdin','-threads','1','-i',file,'-map','0:v:0','-frames:v','1','-f','null','-'],{signal,timeout:30_000});
  const bytes=await fs.readFile(file);if(bytes.length>32*1024**2||bytes[0]!==255||bytes[1]!==216)throw new Error('Ungültiger JPEG-Export.');
  return {width:image.width,height:image.height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
export async function exportPhotoNative(asset,frame,target,config,signal) {
  const decoded=await decodeFrame(asset,frame.requestedAt,target,config,signal,true);
  if(decoded.pts!==frame.pts||decoded.timeBase!==frame.timeBase||decoded.decoderChecksum!==frame.decoderChecksum)throw new Error('Der Export stimmt nicht mit dem geprüften Decoder-Frame überein.');
  return {...await verifyPhotoImage(target,asset,config,signal),pts:decoded.pts,timeBase:decoded.timeBase,at:decoded.at,streamIndex:asset.streamIndex,exportVersion:1};
}
