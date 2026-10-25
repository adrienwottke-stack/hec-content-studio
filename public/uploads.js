import {canRetryUpload,retryUploadStep,retryDelay,waitForUploadRetry} from './upload-retry.js';
let running=false;
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const aborted=()=>new DOMException('Upload pausiert. Mit „Upload fortsetzen“ weiterladen. Nach dem Schließen des Fensters dieselben Dateien erneut auswählen.','AbortError');
async function api(url,{signal,...options}={}) {
  let response;
  try{response=await fetch(url,{...options,signal,headers:{'x-reel-studio':'1',...options.headers}});}
  catch(error){if(signal?.aborted)throw aborted();throw Object.assign(new Error('Verbindung unterbrochen.'),{retryable:true});}
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('Der Server hat diesen Schritt nicht bestätigt.'),{status:response.status,retryable:response.ok});}
  if(!response.ok)throw Object.assign(new Error(data.error||'Upload fehlgeschlagen.'),{status:response.status});
  return data;
}
async function fileKey(file) {
  const metadata=new TextEncoder().encode(JSON.stringify([file.name,file.size,file.lastModified]));
  const head=new Uint8Array(await file.slice(0,65536).arrayBuffer());
  const tail=new Uint8Array(await file.slice(Math.max(0,file.size-65536)).arrayBuffer());
  const bytes=new Uint8Array(metadata.length+head.length+tail.length);bytes.set(metadata);bytes.set(head,metadata.length);bytes.set(tail,metadata.length+head.length);
  return digest(bytes);
}
function chunk(url,blob,checksum,signal,onProgress) {return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhr.open('PATCH',url);xhr.timeout=10*60_000;
  xhr.setRequestHeader('x-reel-studio','1');xhr.setRequestHeader('Content-Type','application/octet-stream');
  xhr.setRequestHeader('x-chunk-size',String(blob.size));xhr.setRequestHeader('x-chunk-sha256',checksum);
  const stop=()=>xhr.abort();signal?.addEventListener('abort',stop,{once:true});
  const finish=(action,value)=>{signal?.removeEventListener('abort',stop);action(value);};
  xhr.upload.onprogress=event=>onProgress(event.loaded);
  xhr.onload=()=>{let data;try{data=JSON.parse(xhr.responseText);}catch{return finish(reject,Object.assign(new Error('Dieser Upload-Teil wurde nicht bestätigt.'),{status:xhr.status,retryable:xhr.status>=200&&xhr.status<300}));}
    xhr.status>=200&&xhr.status<300?finish(resolve,data):finish(reject,Object.assign(new Error(data.error||'Upload-Teil fehlgeschlagen.'),{status:xhr.status}));};
  xhr.onerror=()=>finish(reject,Object.assign(new Error('Verbindung unterbrochen.'),{retryable:true}));
  xhr.ontimeout=()=>finish(reject,Object.assign(new Error('Die Übertragung dieses Teils wurde unterbrochen.'),{retryable:true}));
  xhr.onabort=()=>finish(reject,signal?.aborted?aborted():Object.assign(new Error('Der Browser hat die Verbindung unterbrochen.'),{retryable:true}));
  if(signal?.aborted)return finish(reject,aborted());xhr.send(blob);
});}
async function verifyResume(file,transfer) {
  if(!transfer.lastChunk||transfer.status==='complete')return;
  const last=transfer.lastChunk;
  if(await digest(await file.slice(last.offset,last.offset+last.length).arrayBuffer())!==last.sha256)throw new Error('Die ausgewählte Datei stimmt nicht mit dem begonnenen Upload überein. Bitte die ursprüngliche Datei auswählen.');
}

export async function uploadMany(files,{fields={},signal,onProgress=()=>{},onSaved=()=>{},onProblem=()=>{},waitForRetry=waitForUploadRetry}={}) {
  if(running)throw new Error('Ein Upload läuft bereits. Bitte diesen zuerst beenden oder pausieren.');
  running=true;const clips=[],failures=[];let duplicates=0,completedBytes=0;
  const total=files.reduce((sum,file)=>sum+file.size,0);
  try {
    for(let index=0;index<files.length;index++) {
      const file=files[index];if(signal?.aborted)throw aborted();
      const report=(offset,stage)=>onProgress({index,count:files.length,file,loaded:completedBytes+offset,total,stage});
      try {
        report(0,'Wird vorbereitet');const key=await fileKey(file);
        const recover=(action,offset=0)=>retryUploadStep(action,{signal,wait:waitForRetry,
          onRetry:()=>report(offset,'Verbindung unterbrochen · wird automatisch fortgesetzt')});
        let transfer=await recover(()=>api('/api/library/transfers',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({key,name:file.name,size:file.size,fields})}));
        await verifyResume(file,transfer);
        let chunkSize=Math.min(transfer.chunkBytes,4*1024**2),attempts=0;
        while(transfer.status!=='complete'&&transfer.offset<file.size) {
          if(signal?.aborted)throw aborted();const offset=transfer.offset;
          const blob=file.slice(offset,Math.min(offset+chunkSize,file.size));const checksum=await digest(await blob.arrayBuffer());
          report(offset,offset?'Upload wird fortgesetzt':'Wird hochgeladen');
          try {
            transfer=await chunk(`/api/library/transfers/${transfer.id}/chunks?offset=${offset}`,blob,checksum,signal,
              loaded=>report(offset+loaded,'Wird hochgeladen'));attempts=0;
          } catch(error) {
            if(signal?.aborted)throw aborted();if(!canRetryUpload(error))throw error;
            report(offset,'Verbindung unterbrochen · bestätigten Stand abrufen');await waitForRetry(retryDelay(++attempts),signal);
            transfer=await recover(()=>api(`/api/library/transfers/${transfer.id}`,{signal}),offset);await verifyResume(file,transfer);
            chunkSize=Math.max(256*1024,Math.floor(chunkSize/2));
          }
        }
        if(transfer.status!=='complete') {
          report(file.size,'Original wird geprüft und abgelegt');
          let finishAttempts=0;
          while(transfer.status!=='complete') {
            try{transfer=await api(`/api/library/transfers/${transfer.id}/finish`,{method:'POST',signal});}
            catch(error){
              if(signal?.aborted)throw aborted();
              // Check the receipt before repeating an unconfirmed completion.
              const confirmed=await recover(()=>api(`/api/library/transfers/${transfer.id}`,{signal}),file.size);
              if(confirmed.status==='complete'){transfer=confirmed;break;}
              if(!canRetryUpload(error))throw error;
              report(file.size,'Original wird geprüft · Bestätigung wird wiederholt');
              await waitForRetry(retryDelay(++finishAttempts),signal);transfer=confirmed;
            }
          }
        }
        clips.push(transfer.clip);if(transfer.duplicate)duplicates++;
        completedBytes+=file.size;report(0,transfer.duplicate?'Bereits vorhanden':'Gespeichert');onSaved({index,file,clip:transfer.clip,duplicate:transfer.duplicate});
      } catch(error) {
        if(signal?.aborted||error.name==='AbortError')throw aborted();
        failures.push({index,name:file.name,error:error.message});onProblem({index,file,error});
        if([401,403,507].includes(error.status))break;
      }
    }
    return {clips:[...new Map(clips.map(clip=>[clip.id,clip])).values()],duplicates,failures};
  } finally {running=false;}
}
