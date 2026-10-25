export const uploadAborted=()=>new DOMException('Upload pausiert. Mit „Fortsetzen“ weiterladen.','AbortError');
export const canRetryUpload=error=>Boolean(error?.retryable)||[408,409,425,429].includes(error?.status)||(error?.status>=500&&error?.status<600&&![501,505,507].includes(error.status));
export const retryDelay=attempt=>Math.min(30_000,1000*2**Math.min(attempt-1,5));

export function waitForUploadRetry(ms,signal,{page=globalThis.document,window=globalThis.window}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(uploadAborted());
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      page?.removeEventListener('resume',wake);page?.removeEventListener('visibilitychange',visible);
      window?.removeEventListener('online',wake);window?.removeEventListener('pageshow',wake);};
    const wake=()=>{cleanup();resolve();};
    const visible=()=>{if(page?.visibilityState==='visible')wake();};
    const abort=()=>{cleanup();reject(uploadAborted());};
    const timer=setTimeout(wake,ms);
    signal?.addEventListener('abort',abort,{once:true});
    page?.addEventListener('resume',wake);page?.addEventListener('visibilitychange',visible);
    window?.addEventListener('online',wake);window?.addEventListener('pageshow',wake);
  });
}

export async function retryUploadStep(action,{signal,onRetry=()=>{},wait=waitForUploadRetry}={}) {
  let attempt=0;
  for(;;) {
    if(signal?.aborted)throw uploadAborted();
    try{return await action();}
    catch(error) {
      if(signal?.aborted)throw uploadAborted();
      if(!canRetryUpload(error))throw error;
      onRetry(error,++attempt);await wait(retryDelay(attempt),signal);
    }
  }
}
