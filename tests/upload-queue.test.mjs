import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {UploadQueue} from '../public/upload-queue.js';

const file=(name,size=100)=>({name,size});
const clip=name=>({id:name,name});
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Queue did not reach the expected state.');};
const save=(files,options)=>{
  let loaded=0;
  for(let index=0;index<files.length;index++) {
    loaded+=files[index].size;
    options.onProgress({file:files[index],index,count:files.length,loaded,total:files.reduce((sum,file)=>sum+file.size,0),stage:'Gespeichert'});
    options.onSaved({index,file:files[index],clip:clip(files[index].name),duplicate:false});
  }
  return {clips:files.map(file=>clip(file.name)),failures:[],duplicates:0};
};
test('multiple submissions keep independent files and metadata while one serial upload runs',async()=>{
  const calls=[];let finish;
  const queue=new UploadQueue({id:randomUUID,upload:async(files,options)=>{
    calls.push({names:files.map(file=>file.name),collection:options.fields.collection});
    if(calls.length===1)await new Promise(resolve=>{finish=resolve;});
    return save(files,options);
  }});
  const source=[file('one.mp4'),file('two.mp4')],fields={collection:'First session'};
  const first=queue.enqueue({files:source,fields,label:'First'});
  source.length=0;fields.collection='Changed in form';
  const second=queue.enqueue({files:[file('three.mp4')],fields:{collection:'Second session'}});
  assert.equal(calls.length,1);assert.equal(queue.list().find(task=>task.id===second).status,'queued');
  assert.deepEqual(calls[0],{names:['one.mp4','two.mp4'],collection:'First session'});
  finish();await until(()=>queue.list().every(task=>task.status==='done'));
  assert.equal(calls.length,2);const task=queue.list().find(task=>task.id===first);
  assert.equal(task.loaded,200);assert.equal(task.saved,2);assert.equal(task.percent,100);
  assert.equal(queue.hasUnfinished(),false);
});
test('pause and resume keep saved files and resume only the unfinished original',async()=>{
  const calls=[];
  const queue=new UploadQueue({id:randomUUID,upload:async(files,options)=>{
    calls.push(files.map(file=>file.name));
    if(calls.length===1){
      options.onSaved({index:0,file:files[0],clip:clip(files[0].name),duplicate:false});
      options.onProgress({index:1,file:files[1],loaded:140,total:200,stage:'Wird hochgeladen'});
      await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Paused','AbortError')),{once:true}));
    }
    return save(files,options);
  }});
  const id=queue.enqueue({files:[file('saved.mp4'),file('partial.mp4')]});
  assert.equal(queue.list()[0].loaded,140);queue.pause(id);
  await until(()=>queue.list()[0].status==='paused');
  assert.equal(queue.list()[0].saved,1);assert.equal(queue.hasUnfinished(),true);
  queue.resume(id);await until(()=>queue.list()[0].status==='done');
  assert.deepEqual(calls,[['saved.mp4','partial.mp4'],['partial.mp4']]);assert.equal(queue.list()[0].percent,100);
});
test('an unconfirmed final action can retry with the same ID without uploading originals twice',async()=>{
  let uploads=0;const receipts=[];
  const queue=new UploadQueue({id:randomUUID,upload:async(files,options)=>{uploads++;return save(files,options);}});
  const id=queue.enqueue({files:[file('source.mp4')],kind:'reel',afterUpload:async task=>{
    receipts.push(task.id);if(receipts.length===1)throw new Error('Response lost; inspect the existing job');return {id:task.id,status:'queued'};
  }});
  await until(()=>queue.list()[0].status==='error');assert.equal(queue.list()[0].saved,1);
  queue.resume(id);await until(()=>queue.list()[0].status==='done');
  assert.deepEqual(receipts,[id,id]);assert.equal(uploads,1);assert.equal(queue.list()[0].result.id,id);
});
test('cancelling a running task never schedules its Reel and releases the next queued upload',async()=>{
  let calls=0,finalized=0;
  const queue=new UploadQueue({id:randomUUID,upload:async(files,options)=>{
    if(++calls===1)await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
    return save(files,options);
  }});
  const first=queue.enqueue({files:[file('cancel.mp4')],afterUpload:()=>{finalized++;}});
  const second=queue.enqueue({files:[file('next.mp4')]});queue.cancel(first);
  await until(()=>queue.list().find(task=>task.id===second).status==='done');
  assert.equal(finalized,0);assert.equal(queue.list()[0].status,'cancelled');
  queue.dismiss(first);assert.equal(queue.list().length,1);
});
test('partial file failures retry only unfinished files and defer the Reel until all sources are saved',async()=>{
  const calls=[];let finalized=0;
  const queue=new UploadQueue({id:randomUUID,upload:async(files,options)=>{
    calls.push(files.map(file=>file.name));
    if(calls.length===1){
      options.onSaved({index:0,file:files[0],clip:clip(files[0].name),duplicate:false});
      options.onProblem({index:1,file:files[1],error:new Error('Temporary connection failure')});
      return {clips:[clip(files[0].name)],failures:[{index:1,name:files[1].name,error:'Temporary connection failure'}]};
    }
    return save(files,options);
  }});
  const id=queue.enqueue({files:[file('good.mp4'),file('retry.mp4')],kind:'reel',afterUpload:task=>{finalized++;return {assetIds:task.clips.map(clip=>clip.id)};}});
  await until(()=>queue.list()[0].status==='error');assert.equal(finalized,0);
  queue.resume(id);await until(()=>queue.list()[0].status==='done');
  assert.equal(finalized,1);assert.deepEqual(calls,[['good.mp4','retry.mp4'],['retry.mp4']]);
  assert.deepEqual(queue.list()[0].result.assetIds,['good.mp4','retry.mp4']);
});
