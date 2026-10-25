import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { configuration } from '../lib/config.mjs';
import { validatePlan, quickPlan } from '../lib/plan.mjs';
import { hookSubtitle } from '../lib/media.mjs';
import { JobStore } from '../lib/store.mjs';
import { createStudio } from '../server.mjs';

const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../work/tests');
await fs.mkdir(scratch, { recursive: true });
const asset = { id: 'source', duration: 10 };
const plan = () => ({ summary:'Sichtbare Szene', reels:[{ title:'Billard', hook:'Der nächste Stoß', caption:'Ein gemeinsamer Abend.', hypothesis:'Reaktion zuerst testen.', segments:[{ assetId:'source', from:2, duration:3, reason:'Sichtbare Reaktion.' }] }] });

test('AI cut marks cannot select unknown files or exceed source bounds', () => {
  const unknown = plan(); unknown.reels[0].segments[0].assetId = '../../private';
  assert.throws(() => validatePlan(unknown,[asset]), /unbekannte/);
  const beyond = plan(); beyond.reels[0].segments[0].from = 9;
  assert.throws(() => validatePlan(beyond,[asset]), /außerhalb/);
  const invalid = plan(); invalid.reels[0].segments[0].duration = Infinity;
  assert.throws(() => validatePlan(invalid,[asset]), /außerhalb/);
});
test('limits the number and total length of generated reels', () => {
  const tooMany = plan(); tooMany.reels.push(tooMany.reels[0]);
  assert.throws(() => validatePlan(tooMany,[asset],1), /Anzahl/);
  const tooLong = plan(); tooLong.reels[0].segments = Array(21).fill(tooLong.reels[0].segments[0]);
  assert.throws(() => validatePlan(tooLong,[asset]), /60/);
});
test('keeps valid source selections and explicitly labels the non-AI cut', () => {
  assert.equal(validatePlan(plan(),[asset]).reels[0].duration,3);
  const quick = quickPlan([asset],15);
  assert.match(quick.summary,/keine KI/);
  assert.equal(quick.reels[0].segments[0].from,0);
});
test('provider text cannot inject ASS styling or drawing instructions', () => {
  const ass = hookSubtitle('Text {\\p1} Zeichnung',1080,1920,3);
  const dialogue = ass.split('Dialogue:')[1];
  assert.ok(!dialogue.includes('{'));
  assert.ok(!dialogue.includes('\\p1'));
});
test('production needs a password and unauthenticated dev stays local', () => {
  assert.throws(() => configuration({ NODE_ENV:'production' }), /STUDIO_PASSWORD/);
  assert.throws(() => configuration({ HOST:'0.0.0.0' }), /localhost/);
});
test('a restart does not repeat an interrupted provider job automatically', async () => {
  const directory = await fs.mkdtemp(path.join(scratch,'recovery-'));
  const first = new JobStore(directory); await first.initialize();
  const id = randomUUID();
  await first.create({ id, status:'processing', createdAt:new Date().toISOString(), assets:[], options:{mode:'ai'} });
  const second = new JobStore(directory); await second.initialize();
  assert.equal(second.get(id).status,'error');
  assert.throws(() => second.directory('../elsewhere'),/Ungültige/);
  await second.remove(id); await fs.rmdir(directory);
});

test('login, CSRF protection and downloads stay private', async t => {
  const directory = await fs.mkdtemp(path.join(scratch,'http-'));
  const password = 'only-for-local-contract-test';
  const config = configuration({ DATA_DIR:directory, STUDIO_PASSWORD:password });
  const studio = await createStudio(config);
  const server = studio.app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await studio.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/config`)).status,401);
  assert.equal((await fetch(`${base}/api/jobs`)).status,401);
  assert.equal((await fetch(`${base}/api/health`)).status,200);
  const login = await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json','x-reel-studio':'1'},body:JSON.stringify({password})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'Content-Type':'application/json', 'x-reel-studio':'1' };
  const settings = await (await fetch(`${base}/api/config`,{headers})).json();
  assert.equal(settings.analysisReady,false);
  assert.ok(!Object.hasOwn(settings,'password'));
  assert.ok(!Object.hasOwn(settings,'apiKey'));
  assert.equal((await fetch(`${base}/api/jobs`,{method:'POST',headers:{cookie}})).status,403);
  assert.equal((await fetch(`${base}/api/logout`,{method:'POST',headers:{...headers,origin:'https://unrelated.invalid'}})).status,403);
  const id = randomUUID();
  await studio.store.create({ id,status:'done',createdAt:new Date().toISOString(), assets:[{id:'a',name:'a.mp4',path:'private-path',size:1}],outputs:[] });
  const jobs = await (await fetch(`${base}/api/jobs`,{headers})).json();
  assert.ok(!Object.hasOwn(jobs.jobs[0].assets[0],'path'));
  assert.equal((await fetch(`${base}/api/jobs/${id}/files/provider-settings.json`,{headers})).status,404);
  assert.equal((await fetch(`${base}/api/jobs/${id}`,{method:'DELETE',headers})).status,200);
});
