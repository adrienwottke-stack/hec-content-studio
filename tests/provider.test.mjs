import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planWithGemini } from '../lib/provider.mjs';
import { catalogWithGemini } from '../lib/catalog.mjs';

test('Gemini adapter uses real REST shape, validated cut marks and file cleanup (mock provider)', async t => {
  const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../work/tests');
  await fs.mkdir(scratch,{recursive:true});
  const directory = await fs.mkdtemp(path.join(scratch,'provider-'));
  const proxy = path.join(directory,'proxy.mp4'); await fs.writeFile(proxy,'mock-video-bytes');
  let generated = 0, deleted = 0, requestBody;
  const plan = { summary:'Mock-Analyse', reels:[{ title:'Mock Reel',hook:'Eine sichtbare Reaktion',caption:'Gemeinsam unterwegs.',hypothesis:'Reaktion am Anfang testen.',segments:[{assetId:'source',from:1,duration:2,reason:'Reaktion'}] }] };
  const server = http.createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type','application/json');
    if (req.url === '/upload/v1beta/files') { res.setHeader('x-goog-upload-url',`http://127.0.0.1:${server.address().port}/upload-bytes`); res.end('{}'); }
    else if (req.url === '/upload-bytes') res.end(JSON.stringify({file:{name:'files/mock-source',uri:'https://provider.invalid/mock-source',state:'ACTIVE'}}));
    else if (req.url === '/v1beta/interactions') {
      generated++; requestBody = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.headers['x-goog-api-key'],'mock-key');
      const result = requestBody.response_format.schema.properties.category
        ? {title:'Testaufnahme',category:'unsortiert',tags:['Testbild'],description:'Eine simulierte technische Aufnahme.',moments:[{label:'Testmoment',from:1,duration:1,description:'Simulierte Fundstelle.'}]}
        : plan;
      res.end(JSON.stringify({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify(result)}]}]}));
    } else if (req.method === 'DELETE') { deleted++; res.end('{}'); }
    else { res.statusCode=404; res.end('{}'); }
  }).listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory,{recursive:true,force:true}); });
  const result = await planWithGemini([{id:'source',name:'source.mov',duration:5}],[proxy],
    {count:1,duration:15,title:'Billard',brief:'Ein echter Moment',goal:'followers'},
    {apiKey:'mock-key',model:'mock-model',providerBase:`http://127.0.0.1:${server.address().port}`},
    new AbortController().signal,async () => {});
  assert.equal(generated,1); assert.equal(deleted,1);
  assert.equal(requestBody.store,false);
  assert.equal(requestBody.response_format.mime_type,'application/json');
  assert.equal(requestBody.input.filter(part => part.type === 'video').length,1);
  assert.equal(result.reels[0].duration,2);
  assert.deepEqual(result.cleanup,[{name:'files/mock-source',deleted:true}]);
  const catalog = await catalogWithGemini({id:'source',name:'Testaufnahme.mp4',duration:5,collections:['Testmaterial'],context:''},proxy,
    {apiKey:'mock-key',model:'mock-model',providerBase:`http://127.0.0.1:${server.address().port}`},new AbortController().signal,async()=>{});
  assert.equal(catalog.category,'unsortiert'); assert.equal(catalog.moments[0].from,1);
  assert.equal(generated,2); assert.equal(deleted,2);
  assert.ok(requestBody.response_format.schema.properties.category.enum.includes('billard'));
  assert.match(requestBody.system_instruction,/Keine Gesichtserkennung/);
});
