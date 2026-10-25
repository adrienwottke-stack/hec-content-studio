import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadMany} from '../public/uploads.js';
import {waitForUploadRetry} from '../public/upload-retry.js';

test('browser aborts and repeated status failures resume confirmed bytes; a lost finish receipt saves once',async t=>{
  const originalFetch=globalThis.fetch,originalXHR=globalThis.XMLHttpRequest;
  t.after(()=>{globalThis.fetch=originalFetch;globalThis.XMLHttpRequest=originalXHR;});
  const file=new File([new Uint8Array(6*1024**2).fill(7)],'background.mp4',{lastModified:100});
  const state={id:'transfer',size:file.size,offset:0,status:'uploading',chunkBytes:16*1024**2,lastChunk:null};
  let chunks=0,reads=0,finishes=0,retries=0;const offsets=[],saved=[],stages=[];
  globalThis.fetch=async(url,options={})=>{
    if(url==='/api/library/transfers')return Response.json(state);
    if(url.endsWith('/finish')) {finishes++;state.status='complete';state.clip={id:'only-original'};state.duplicate=false;throw new TypeError('Lost completion response');}
    if(++reads<=6)throw new TypeError('Background connection unavailable');
    return Response.json(state);
  };
  globalThis.XMLHttpRequest=class {
    upload={};headers={};
    open(method,url){this.url=url;}
    setRequestHeader(key,value){this.headers[key]=value;}
    abort(){this.onabort();}
    send(blob){queueMicrotask(()=>{
      const offset=Number(new URL(this.url,'https://studio.invalid').searchParams.get('offset'));offsets.push(offset);
      assert.equal(offset,state.offset);
      state.offset+=blob.size;state.lastChunk={offset,length:blob.size,sha256:this.headers['x-chunk-sha256']};
      this.upload.onprogress?.({loaded:blob.size});
      if(++chunks===1)this.onabort();
      else {this.status=200;this.responseText=JSON.stringify(state);this.onload();}
    });}
  };
  const result=await uploadMany([file],{onSaved:info=>saved.push(info),onProgress:info=>stages.push(info.stage),
    waitForRetry:async()=>{assert.ok(++retries<20);}});
  assert.equal(result.failures.length,0);assert.equal(result.clips.length,1);assert.equal(saved.length,1);
  assert.deepEqual(offsets,[0,4*1024**2]);assert.equal(finishes,1);assert.ok(reads>6);assert.ok(retries>4);
  assert.ok(stages.some(stage=>stage.includes('automatisch fortgesetzt')));
});

test('authentication and capacity errors remain actionable instead of retrying forever',async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  for(const status of [401,507]) {
    let calls=0,retries=0;
    globalThis.fetch=async()=>{calls++;return Response.json({error:'User action required'},{status});};
    const result=await uploadMany([new File(['fixture'],'source.mp4')],{waitForRetry:async()=>{retries++;}});
    assert.equal(result.failures.length,1);assert.equal(result.clips.length,0);assert.equal(calls,1);assert.equal(retries,0);
  }
});

test('returning from the background wakes recovery; manual pause still stops it',async()=>{
  const page=new EventTarget(),window=new EventTarget();page.visibilityState='hidden';
  const controller=new AbortController();
  const waiting=waitForUploadRetry(60_000,controller.signal,{page,window});
  page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));await waiting;
  const paused=waitForUploadRetry(60_000,controller.signal,{page,window});controller.abort();
  await assert.rejects(paused,error=>error.name==='AbortError');
  page.dispatchEvent(new Event('resume'));window.dispatchEvent(new Event('online'));
});
