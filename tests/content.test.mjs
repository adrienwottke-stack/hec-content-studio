import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContentStore } from '../lib/content-store.mjs';
import { parseCsv, normalizedMeasurement, csvHeader } from '../lib/content-validation.mjs';
import { evidenceFacts, validateProductionPlan, learningSnapshot, productionBrief } from '../lib/content-learning.mjs';
import { knowledgeNotes } from '../lib/content-knowledge.mjs';
import { syncVault } from '../lib/vault-sync.mjs';

const scratch = path.resolve('../../work/tests');
const clock = () => new Date('2026-10-04T20:00:00Z');
const measurement = (extra = {}) => ({ requestId: randomUUID(), accountHandle: 'adrien.e39', permalink: 'https://www.instagram.com/reel/HEC_TEST_ONE/',
  publishedAt: '2026-10-03T18:00:00Z', measuredAt: '2026-10-04T18:00:00Z', source: 'TEST · manual reading', platformScope: 'instagram', distribution: 'organic',
  metrics: { views: 0, reach: 100, shares: 4 }, isTest: true, ...extra });
const features = { topic: 'Sport', opening: 'Sichtbare Aktion', action: 'Bewegung', cut: 'Zwei Szenen', sound: 'Kein Sprachbeleg', text: 'Sachlicher Hook', expectedReaction: 'Interesse an der Aktivität' };
const plan = assetId => ({ title: 'TEST · Sport', hook: 'Sichtbare Aktion', caption: 'TEST', hypothesis: 'TEST · Nutzerreview prüfen', duration: 2,
  segments: [{ assetId, from: 1, duration: 2, reason: 'Testmarke' }], features: { ...features, lengthSeconds: 2 }, briefingApplied: [] });
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true }); const root = await fs.mkdtemp(path.join(scratch, 'content-'));
  t.after(async () => { if (!root.startsWith(scratch + path.sep)) throw new Error('Unexpected test path'); await fs.rm(root, { recursive: true, force: true }); });
  const store = new ContentStore(root, { clock }); await store.initialize(); return { store, root };
}
async function draft(store, { isTest = true, collection = 'TEST', requestId = randomUUID(), assetId = randomUUID() } = {}) {
  const clip = { id: assetId, status: 'ready', archived: false, duration: 10, category: 'Sport', collections: [collection], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' };
  const version = await store.reserveDraft({ requestId, assetIds: [assetId], title: 'TEST', collection, isTest }, [clip]);
  await store.planReceived(version.jobId, { reels: [plan(assetId)] });
  await store.jobObserved({ id: version.jobId, status: 'done', outputs: [{}] }, [{ videoSha256: 'contract-fixture', videoUrl: '/api/jobs/test/files/reel.mp4' }]);
  return { version: store.version(version.id), clip };
}
async function publication(store, version, extra = {}) {
  return store.publication({ requestId: randomUUID(), versionId: version.id, accountId: version.accountId, isTest: version.isTest, confirmMapping: true,
    permalink: 'https://www.instagram.com/reel/HEC_TEST_ONE/', publishedAt: '2026-10-03T18:00:00Z', ...extra });
}

test('manual metrics preserve unknown and zero; reject invalid counts, chronology and timezone', () => {
  const result = normalizedMeasurement(measurement(), clock()); assert.equal(result.values.views, 0); assert.equal(result.values.likes, null); assert.equal(result.ageHours, 24);
  for (const value of ['1,000', '1.000,5', -1, 0.5, true, '1e3', ' ']) assert.throws(() => normalizedMeasurement(measurement({ metrics: { views: value } }), clock()));
  assert.throws(() => normalizedMeasurement(measurement({ publishedAt: '2026-10-03T18:00:00' }), clock()), /Zeitzone/);
  assert.throws(() => normalizedMeasurement(measurement({ publishedAt: '2026-02-30T18:00:00Z' }), clock()), /existiert/);
  assert.throws(() => normalizedMeasurement(measurement({ measuredAt: '2026-10-02T18:00:00Z' }), clock()), /vor der/);
});
test('changed publication mappings and expired references invalidate prior conclusions and allow fresh evidence',async t=>{
 const {store}=await fixture(t),first=await draft(store),pub=await publication(store,first.version),reading=await store.measurement(measurement());
 const run=await store.prepareLearning({accountId:first.version.accountId,isTest:true});await store.learningDone(run.id,{summary:'TEST',learnings:[{kind:'measured-hint',title:'TEST',observation:'One explicit TEST reading',nextExperiment:'Another TEST',topic:'Sport',sourceIds:[reading.measurement.id],limitations:['Synthetic single sample']} ]});
 assert.equal(store.brief(first.version.accountId,{isTest:true,topics:['Sport']}).learnings.length,1);
 await store.mapPublication(pub.id,{requestId:randomUUID(),withdraw:true,reason:'TEST: wrong cut mapped'});assert.equal(store.brief(first.version.accountId,{isTest:true}).learnings.length,0);
 const second=await draft(store);await store.mapPublication(pub.id,{requestId:randomUUID(),confirmMapping:true,versionId:second.version.id});assert.equal(store.brief(first.version.accountId,{isTest:true}).learnings.length,0);
 assert.ok(learningSnapshot(store.state,first.version.accountId,true,clock()).freshIds.includes(reading.measurement.id));assert.equal(store.snapshot({test:true}).learnings.at(-1).evidenceCurrent,false);
 const reference=await store.reference({requestId:randomUUID(),accountId:first.version.accountId,isTest:true,url:'https://www.instagram.com/reel/HEC_TEST_REFERENCE/',observedAt:'2026-10-03T20:00:00Z',recheckAt:'2026-10-04T21:00:00Z',topic:'Sport',opening:'TEST action',relevance:'TEST',experiment:'TEST',uncertainty:'TEST not a trend'});
 const refRun=await store.prepareLearning({accountId:first.version.accountId,isTest:true});await store.learningDone(refRun.id,{summary:'TEST',learnings:[{kind:'reference-experiment',title:'TEST reference',observation:'Dated example',nextExperiment:'TEST action first',topic:'Sport',sourceIds:[reference.id],limitations:['Single example']} ]});
 assert.ok(productionBrief(store.state,first.version.accountId,{isTest:true,now:clock()}).learnings.some(item=>item.kind==='reference-experiment'));
 assert.ok(!productionBrief(store.state,first.version.accountId,{isTest:true,now:new Date('2026-10-04T22:00:00Z')}).learnings.some(item=>item.kind==='reference-experiment'));
});
test('quoted CSV, repeated import and invalid rows are durable without phantom publications', async t => {
  const { store, root } = await fixture(t);
  const row = 'adrien.e39;;; ;https://www.instagram.com/reel/HEC_TEST_ONE/;2026-10-03T18:00:00Z;2026-10-04T18:00:00Z;TEST;;instagram;organic;0;100;;;4;;;;;"quoted;note\nsecond line"';
  const csv = `\uFEFF${csvHeader}\r\n${row.replace(';;; ;', ';;;;')}\r\n`;
  assert.equal(parseCsv(csv)[0].value.notes, 'quoted;note\nsecond line');
  const first = await store.importCsv({ csv, isTest: true }); assert.equal(first.created, 1); assert.equal(first.errors, 0);
  const again = await store.importCsv({ csv, isTest: true }); assert.equal(again.idempotent, true);
  const reformatted = await store.importCsv({ csv: csv.replace(/\r\n/g, '\n'), isTest: true }); assert.equal(reformatted.duplicates, 1);
  const restarted = new ContentStore(root, { clock }); await restarted.initialize(); assert.equal(restarted.state.measurements.length, 1);
  const invalid = await restarted.importCsv({ csv: csv.replace('HEC_TEST_ONE', 'HEC_TEST_BAD').replace(';0;100;', ';-1;100;'), isTest: true });
  assert.equal(invalid.errors, 1); assert.equal(restarted.state.publications.length, 1);
});
test('feedback creates V2 once; V1 export and approval history survive; stale approval is refused', async t => {
  const { store } = await fixture(t), { version } = await draft(store);
  await store.review(version.id, { requestId: randomUUID(), action: 'approve' });
  const requestId = randomUUID(), change = { requestId, action: 'changes', feedback: 'Anfang kürzer' };
  const result = await store.review(version.id, change), repeated = await store.review(version.id, change);
  assert.equal(result.revision.number, 2); assert.equal(repeated.revision.id, result.revision.id); assert.equal(repeated.idempotent, true);
  assert.equal(store.version(version.id).exports.videoSha256, 'contract-fixture'); assert.equal(store.version(result.revision.id).reviewStatus, 'pending-render');
  assert.ok(store.state.reviews.some(item => item.action === 'approve' && item.versionId === version.id));
  await assert.rejects(() => store.review(version.id, { requestId: randomUUID(), action: 'approve' }), error => error.status === 409);
  const old = await store.review(version.id, { requestId: randomUUID(), action: 'feedback', feedback: 'Notiz zur alten Version' }); assert.equal(old.review.stale, true);
});
test('unconfirmed and external publications never become version performance evidence', async t => {
  const { store } = await fixture(t), { version } = await draft(store);
  await store.measurement(measurement({ reelId: version.conceptId, reelVersion: 1 }));
  assert.equal(evidenceFacts(store.state, version.accountId, true, clock()).filter(item => item.kind === 'measurement').length, 0);
  const pub = store.state.publications[0];
  await store.mapPublication(pub.id, { requestId: randomUUID(), versionId: version.id, confirmMapping: true, externalVariant: true });
  assert.equal(evidenceFacts(store.state, version.accountId, true, clock()).length, 0);
  await store.mapPublication(pub.id, { requestId: randomUUID(), withdraw: true, reason: 'TEST · Korrektur der Zuordnung' });
  await store.mapPublication(pub.id, { requestId: randomUUID(), versionId: version.id, confirmMapping: true });
  assert.equal(evidenceFacts(store.state, version.accountId, true, clock()).filter(item => item.kind === 'measurement').length, 1);
});
test('corrections retain originals, exclude the superseded reading and prevent branching correction retries', async t => {
  const { store } = await fixture(t), { version } = await draft(store); await publication(store, version);
  const first = await store.measurement(measurement());
  const corrected = await store.measurement(measurement({ correctionOf: first.measurement.id, metrics: { views: 0, reach: 0, shares: 0 } }));
  assert.equal(store.state.measurements.length, 2); assert.equal(store.snapshot({ test: true }).activeMeasurementIds[0], corrected.measurement.id);
  assert.equal(evidenceFacts(store.state, version.accountId, true, clock())[0].rates.sharesPer1000Reach, null);
  await assert.rejects(() => store.measurement(measurement({ correctionOf: first.measurement.id, metrics: { views: 2 } })), error => error.status === 409);
});
test('a single confirmed measurement yields a bounded learning, atomic vault note and applied next briefing', async t => {
  const { store, root } = await fixture(t), { version } = await draft(store); await publication(store, version);
  const saved = await store.measurement(measurement()); const run = await store.prepareLearning({ accountId: version.accountId, isTest: true });
  assert.equal(run.comparisons[0].sampleSize, 1);
  const result = { summary: 'TEST · ein bestätigter Messpunkt, kein Erfolgsbeweis', learnings: [{ kind: 'measured-hint', title: 'TEST · sichtbare Aktion weiter prüfen', topic: 'Sport',
    observation: 'TEST · 100 erreichte Konten und 4 Teilungen nach 24 Stunden.', nextExperiment: 'Den sichtbaren Aktionsbeginn früher setzen und bei gleichem Alter erneut messen.',
    sourceIds: [saved.measurement.id], limitations: ['Ein Beitrag; Verteilung und Inhalt können Unterschiede erklären.'] }] };
  await store.learningDone(run.id, result); assert.equal((await store.learningDone(run.id, result)).idempotent, true);
  assert.equal(await store.prepareLearning({ accountId: version.accountId, isTest: true }), null);
  const next = await draft(store, { assetId: randomUUID() }), brief = next.version.briefing;
  assert.equal(brief.learnings.length, 1); assert.match(brief.learnings[0].nextExperiment, /früher/);
  const raw = { reels: [{ ...plan(next.clip.id), segments: [{ assetId: next.clip.id, from: 0, duration: 2, reason: 'Aktionsbeginn früher; TEST' }], briefingApplied: [{ sourceId: brief.learnings[0].id, change: 'Die Aktion beginnt jetzt direkt bei 0 Sekunden.' }] }] };
  const validated = validateProductionPlan(raw, raw, next.version, store.state); assert.equal(validated.reels[0].segments[0].from, 0);
  const vault = path.join(root, 'vault'); await fs.mkdir(vault); const payload = knowledgeNotes(store.state, { test: true });
  const first = await syncVault(payload, { vault }), second = await syncVault(payload, { vault }); assert.ok(first.created > 0); assert.equal(second.created, 0); assert.equal(second.updated, 0);
  const learningNote = payload.notes.find(item => item.type === 'studio-learning'); assert.match(learningNote.content, /100 erreichte/);
  assert.equal(store.brief(version.accountId, { isTest: false, topics: ['Sport'] }).learnings.length, 0);
});
test('24h and seven-day readings are not compared; unknown distribution does not create a control group', async t => {
  const { store } = await fixture(t), one = await draft(store), two = await draft(store);
  await publication(store, one.version); await publication(store, two.version, { permalink: 'https://www.instagram.com/reel/HEC_TEST_TWO/', publishedAt: '2026-09-27T18:00:00Z' });
  await store.measurement(measurement()); await store.measurement(measurement({ permalink: 'https://www.instagram.com/reel/HEC_TEST_TWO/', publishedAt: '2026-09-27T18:00:00Z', metrics: { views: 500 } }));
  const run = await store.prepareLearning({ accountId: one.version.accountId, isTest: true }); assert.ok(run.comparisons.every(item => item.sampleSize === 1));
});
test('autopilot reserves capacity atomically, enforces daily timezone boundary and survives restart', async t => {
  const { store, root } = await fixture(t), accountId = store.defaultAccount().id;
  const clips = Array.from({ length: 4 }, () => ({ id: randomUUID(), status: 'ready', archived: false, duration: 10, category: 'Sport', collections: ['TEST'], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' }));
  await store.collectionUpdate({ accountId, name: 'TEST', isTest: true, enabled: true, maxPerDay: 1, maxOpen: 3, checkMinutes: 5 }, ['TEST']);
  assert.equal((await store.reserveAutopilot(clips)).length,0);
  const result = await Promise.all([store.reserveAutopilot(clips,{isTest:true}), store.reserveAutopilot(clips,{isTest:true})]); assert.equal(result.flat().length, 1);
  const restarted = new ContentStore(root, { clock }); await restarted.initialize(); assert.equal((await restarted.reserveAutopilot(clips,{isTest:true})).length, 0);
  await restarted.transaction(state => { state.collections[0].lastCheckAt = null; return {}; }); assert.equal((await restarted.reserveAutopilot(clips,{isTest:true})).length, 0);
  assert.match(restarted.state.collections[0].waitReason, /Tagesgrenze/);
});
test('maximum open proposals includes work in progress; revisions do not consume a new concept slot', async t => {
  const { store } = await fixture(t); const first = await draft(store), second = await draft(store), third = await draft(store);
  await store.collectionUpdate({ name: 'TEST', isTest: true, enabled: true, maxPerDay: 5, maxOpen: 3, checkMinutes: 5 }, ['TEST']);
  assert.equal((await store.reserveAutopilot([first.clip, second.clip, third.clip],{isTest:true})).length, 0);
  assert.match(store.state.collections[0].waitReason, /Obergrenze/);
  assert.equal((await store.review(first.version.id, { requestId: randomUUID(), action: 'changes', feedback: 'TEST · schneller zur Aktion' })).revision.number, 2);
  assert.equal(store.state.concepts.length, 3);
});
test('real autopilot waits for every new clip, without consuming the daily check, then reserves one proposal', async t => {
  const { store } = await fixture(t);
  const reviewed = (use = 'strong') => ({ classificationSource: 'codex', analysisStatus: 'done', brainReview: { assessment: { use } } });
  const makeClip = (extra = {}) => ({ id: randomUUID(), status: 'ready', archived: false, duration: 10, category: 'sport', collections: ['REAL'],
    createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', ...extra });
  const oldClip = makeClip(reviewed());
  const newClips = Array.from({ length: 8 }, (_, index) => makeClip({ status: index === 0 ? 'queued' : index === 1 ? 'processing' : 'ready', classificationSource: 'filename', analysisStatus: 'waiting-codex' }));
  const unrelated = makeClip({ collections: ['OTHER'], analysisStatus: 'pending' });
  const archived = makeClip({ archived: true, analysisStatus: 'pending' });
  const clips = [oldClip, ...newClips, unrelated, archived];
  await store.collectionUpdate({ name: 'REAL', enabled: true, maxPerDay: 1, maxOpen: 3, checkMinutes: 1440 }, ['REAL']);
  assert.equal((await store.reserveAutopilot(clips)).length, 0);
  assert.match(store.state.collections[0].waitReason, /8 Codex-Auswertungen offen/);
  assert.equal(store.state.collections[0].lastCheckAt, undefined);
  assert.equal(store.state.concepts.length, 0);
  for (const [index, clip] of newClips.entries()) Object.assign(clip, { status: 'ready', ...reviewed(index === 0 ? 'unsuitable' : index === 1 ? 'needs-context' : 'supporting') });
  const result = await Promise.all([store.reserveAutopilot(clips), store.reserveAutopilot(clips)]);
  assert.equal(result.flat().length, 1);
  assert.equal(store.state.concepts.length, 1);
  assert.equal(store.state.collections[0].lastCheckAt, clock().toISOString());
  assert.ok(result.flat()[0].assetIds.every(id => ![newClips[0].id, newClips[1].id, unrelated.id, archived.id].includes(id)));
});
test('real autopilot exposes incomplete and failed classifications while feedback revisions remain available', async t => {
  const { store } = await fixture(t), { version, clip } = await draft(store, { isTest: false, collection: 'REAL' });
  Object.assign(clip, { classificationSource: 'codex', analysisStatus: 'done', brainReview: { assessment: { use: 'strong' } } });
  await store.collectionUpdate({ name: 'REAL', enabled: true, maxPerDay: 1, maxOpen: 3, checkMinutes: 1440 }, ['REAL']);
  const failed = { ...clip, id: randomUUID(), status: 'error', analysisStatus: 'error', brainReview: null };
  const staleReview = { ...clip, id: randomUUID(), analysisStatus: 'waiting-codex' };
  const nameOnly = { ...clip, id: randomUUID(), classificationSource: 'filename' };
  assert.equal((await store.reserveAutopilot([clip, failed, staleReview, nameOnly])).length, 0);
  assert.match(store.state.collections[0].waitReason, /2 Codex-Auswertungen offen/);
  assert.match(store.state.collections[0].waitReason, /1 technisch nicht verfügbare Aufnahmen bleiben ungesichtet/);
  assert.equal(store.state.collections[0].pendingClassificationCount, 2);
  assert.equal(store.state.collections[0].unavailableClipCount, 1);
  const result = await store.review(version.id, { requestId: randomUUID(), action: 'changes', feedback: 'Einstieg schneller zur sichtbaren Aktion' });
  assert.equal(result.revision.parentVersionId, version.id);
  assert.equal(result.revision.renderStatus, 'reserved');
  assert.equal(store.state.concepts.length, 1);
  assert.equal(store.state.versions.length, 2);
  const [reserved] = await store.reserveAutopilot([clip, failed]);
  assert.ok(reserved, 'A terminal technical failure must not deadlock the daily reel');
  assert.deepEqual(reserved.assetIds, [clip.id]);
  assert.equal(store.state.collections[0].pendingClassificationCount, 0);
  assert.equal(store.state.collections[0].unavailableClipCount, 1);
  assert.match(store.state.collections[0].waitReason, /ungesichtet und ausgeschlossen/);
});
test('autopilot waits for the matching account learning before reserving a fresh briefing', async t => {
  const { store } = await fixture(t), { version, clip } = await draft(store, { isTest: false, collection: 'REAL' });
  Object.assign(clip, { classificationSource: 'codex', analysisStatus: 'done', brainReview: { assessment: { use: 'strong' } } });
  await store.collectionUpdate({ name: 'REAL', enabled: true, maxPerDay: 1, maxOpen: 3, checkMinutes: 1440 }, ['REAL']);
  await store.review(version.id, { requestId: randomUUID(), action: 'process', feedback: 'Den sichtbaren Aktionsbeginn früher setzen und wieder prüfen.' });
  const run = await store.prepareLearning({ accountId: version.accountId, isTest: false });
  assert.equal(run.status, 'queued');
  assert.equal((await store.reserveAutopilot([clip])).length, 0);
  assert.match(store.state.collections[0].waitReason, /neue Feedback auswerten/);
  assert.equal(store.state.collections[0].lastCheckAt, undefined);
  await store.transaction(state => { state.learningRuns.find(item => item.id === run.id).status = 'waiting-codex'; return {}; });
  assert.equal((await store.reserveAutopilot([clip])).length, 0);
  await store.transaction(state => { state.learningRuns.find(item => item.id === run.id).status = 'error'; return {}; });
  assert.equal((await store.reserveAutopilot([clip])).length, 0);
  assert.match(store.state.collections[0].waitReason, /Lernlauf ist fehlgeschlagen/);
  assert.equal(store.state.collections[0].lastCheckAt, undefined);
  const revision = await store.review(version.id, { requestId: randomUUID(), action: 'changes', feedback: 'Die Version weiterhin mit früherem Aktionsbeginn überarbeiten.' });
  assert.equal(revision.revision.parentVersionId, version.id);
  await store.transaction(state => { state.learningRuns.find(item => item.id === run.id).status = 'waiting-codex'; return {}; });
  await store.learningDone(run.id, { summary: 'Nutzerwunsch zur Einstiegsgeschwindigkeit als nächsten Versuch gespeichert.', learnings: [{
    kind: 'process-feedback', title: 'Aktionsbeginn früher', topic: 'sport', observation: 'Der Nutzer möchte einen früheren Aktionsbeginn.',
    nextExperiment: 'Den Einstieg am ersten sichtbaren Aktionsmoment beginnen.', sourceIds: [run.facts.find(item => item.kind === 'version-feedback').id], limitations: ['Keine gemessene Instagram-Wirkung.']
  }] });
  await store.transaction(state => { state.learningRuns.push({ id: randomUUID(), accountId: version.accountId, isTest: true, status: 'waiting-codex', facts: [] },
    { id: randomUUID(), accountId: randomUUID(), isTest: false, status: 'queued', facts: [] }); return {}; });
  const [reserved] = await store.reserveAutopilot([clip]);
  assert.ok(reserved);
  assert.ok(reserved.briefing.learnings.some(item => item.nextExperiment === 'Den Einstieg am ersten sichtbaren Aktionsmoment beginnen.'));
});
test('vault sync preserves manual additions, detects edited generated blocks and stays in HEC', async t => {
  const { root } = await fixture(t), vault = path.join(root, 'vault'); await fs.mkdir(vault);
  const noteId = `learning-${randomUUID()}`, payload = { test: false, revision: 'one', notes: [{ id: noteId, content: '# Erstes Ergebnis\nBelegt.' }] };
  const first = await syncVault(payload, { vault }), file = path.join(vault, first.files[noteId]);
  await fs.appendFile(file, 'Meine manuelle Ergänzung.\n');
  const newer = { ...payload, revision: 'two', notes: [{ id: noteId, content: '# Neues Ergebnis\nBelegt und geändert.' }] };
  await syncVault(newer, { vault }); assert.match(await fs.readFile(file, 'utf8'), /Meine manuelle/);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Belegt und geändert.', 'Manuell im generierten Teil.'));
  const conflict = await syncVault(payload, { vault }); assert.equal(conflict.conflicts.length, 1); assert.match(await fs.readFile(file, 'utf8'), /Manuell im generierten/);
  assert.equal((await syncVault(payload, { vault })).conflicts[0].incoming, conflict.conflicts[0].incoming);
  await assert.rejects(() => syncVault(payload, { vault, subfolder: '../fremd' }), /ausschließlich/);
});
