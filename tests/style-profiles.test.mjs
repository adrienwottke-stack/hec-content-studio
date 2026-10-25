import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { styleProfiles, getStyleProfile } from '../lib/style-profiles.mjs';
import { normalizeOptions, createStudio } from '../server.mjs';
import { ContentStore } from '../lib/content-store.mjs';
import { configuration } from '../lib/config.mjs';

const scratch = fileURLToPath(new URL('../../../work/tests/', import.meta.url));
const clock = () => new Date('2026-10-17T18:00:00Z');
const clip = (collection = 'TEST') => ({ id: randomUUID(), status: 'ready', archived: false, duration: 45, category: 'other', collections: [collection],
  createdAt: '2026-10-17T16:00:00Z', updatedAt: '2026-10-17T16:00:00Z' });
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'style-profiles-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(scratch) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const store = new ContentStore(root, { clock }); await store.initialize();
  return { root, store };
}

test('profiles are strict immutable choices and preserve the standard rendering defaults', () => {
  assert.deepEqual(styleProfiles.map(item => item.id), ['standard', 'late-night-drive']);
  assert.equal(getStyleProfile().id, 'standard');
  assert.equal(getStyleProfile('standard').render.showHook, true);
  assert.equal(getStyleProfile('standard').render.normalizeAudio, true);
  const drive = getStyleProfile('late-night-drive');
  assert.deepEqual(drive.targetSeconds, { min: 20, max: 35 });
  assert.deepEqual(drive.shotSeconds, { min: 3, max: 7 });
  assert.deepEqual(drive.render, { showHook: false, normalizeAudio: false, audioFadeSeconds: 0.04, musicGainDb: -24 });
  for (const value of ['', null, 1, {}, ['late-night-drive'], 'Late Night Drive', 'unknown', '../standard']) {
    assert.throws(() => getStyleProfile(value), error => error.status === 400 && /Stilprofil/.test(error.message));
  }
  assert.throws(() => { drive.render.showHook = true; }, TypeError);
  assert.throws(() => { drive.instructions.push('unintended global change'); }, TypeError);
});

test('server normalizes legacy options, retains a selected style and music, and accepts the atmosphere goal', () => {
  const standard = normalizeOptions({});
  assert.equal(standard.styleProfile, 'standard'); assert.equal(standard.goal, 'followers');
  assert.equal(Object.hasOwn(standard, 'musicId'), false);
  const musicId = randomUUID();
  const options = normalizeOptions({ title: 'TEST · Drive', brief: 'Nutzerkontext bleibt bestehen.', mode: 'codex', count: 2,
    duration: 35, goal: 'atmosphere', fit: 'fill', styleProfile: 'late-night-drive', musicId });
  assert.equal(options.styleProfile, 'late-night-drive'); assert.equal(options.goal, 'atmosphere');
  assert.equal(options.duration, 35); assert.equal(options.brief, 'Nutzerkontext bleibt bestehen.');
  assert.equal(options.fit, 'fill'); assert.equal(options.count, 2); assert.equal(options.musicId, musicId);
  assert.equal(normalizeOptions({ goal: 'event' }).goal, 'event');
  assert.throws(() => normalizeOptions({ styleProfile: 'unknown' }), /Stilprofil/);
  assert.throws(() => normalizeOptions({ musicId: '../file' }), /Musik/);
});

test('drafts and feedback revisions retain style and optional music without changing account preferences', async t => {
  const { store, root } = await fixture(t), source = clip(), musicId = randomUUID();
  const preferences = structuredClone({ accounts: store.state.accounts, styles: store.state.styles, learnings: store.state.learnings });
  const version = await store.reserveDraft({ requestId: randomUUID(), assetIds: [source.id], isTest: true, title: 'TEST · Drive',
    brief: 'Ruhiger Originalmoment', styleProfile: 'late-night-drive', musicId, goal: 'atmosphere', duration: 25 }, [source]);
  assert.equal(version.options.styleProfile, 'late-night-drive'); assert.equal(version.options.musicId, musicId);
  assert.equal(version.options.goal, 'atmosphere');
  await store.jobObserved({ id: version.jobId, status: 'done' }, [{ videoSha256: 'TEST-fixture-only', videoUrl: '/test-only.mp4' }]);
  const { revision } = await store.review(version.id, { requestId: randomUUID(), action: 'changes', feedback: 'TEST · Schluss kürzer stehen lassen' });
  assert.deepEqual(revision.options, version.options);
  const restored = new ContentStore(root, { clock }); await restored.initialize();
  assert.deepEqual(restored.version(revision.id).options, version.options);
  assert.deepEqual({ accounts: store.state.accounts, styles: store.state.styles, learnings: store.state.learnings }, preferences);
  const legacy = await store.reserveDraft({ requestId: randomUUID(), assetIds: [source.id], isTest: true }, [source]);
  assert.equal(legacy.options.styleProfile, 'standard');
  const before = store.state.versions.length;
  await assert.rejects(() => store.reserveDraft({ requestId: randomUUID(), assetIds: [source.id], styleProfile: 'unknown' }, [source]), /Stilprofil/);
  assert.equal(store.state.versions.length, before);
});

test('collection updates and autopilot retain the selected style; omitted legacy configuration stays standard', async t => {
  const { store } = await fixture(t), source = clip();
  await store.collectionUpdate({ name: 'TEST', isTest: true, enabled: true, styleProfile: 'late-night-drive', goal: 'atmosphere', duration: 35 }, ['TEST']);
  const updated = await store.collectionUpdate({ name: 'TEST', isTest: true, enabled: true, maxOpen: 2 }, ['TEST']);
  assert.equal(updated.styleProfile, 'late-night-drive'); assert.equal(updated.goal, 'atmosphere');
  const [version] = await store.reserveAutopilot([source], { isTest: true });
  assert.equal(version.options.styleProfile, 'late-night-drive'); assert.equal(version.options.duration, 35); assert.equal(version.options.goal, 'atmosphere');
  const standard = await store.collectionUpdate({ name: 'LEGACY', isTest: true, enabled: true }, ['LEGACY']);
  assert.equal(standard.styleProfile, 'standard');
  await store.transaction(state => { delete state.collections.find(item => item.name === 'LEGACY').styleProfile; return {}; });
  const [legacy] = await store.reserveAutopilot([clip('LEGACY')], { isTest: true });
  assert.equal(legacy.options.styleProfile, 'standard');
  await assert.rejects(() => store.collectionUpdate({ name: 'TEST', isTest: true, styleProfile: 'unknown' }, ['TEST']), /Stilprofil/);
  assert.equal(store.state.collections.find(item => item.name === 'TEST').styleProfile, 'late-night-drive');
});

test('config exposes available profiles and new output evidence downloads stay behind authentication', async t => {
  const { root } = await fixture(t), password = 'ONLY-LOCAL-STYLE-CONTRACT-TEST';
  const studio = await createStudio(configuration({ DATA_DIR: root, STUDIO_PASSWORD: password }), { scheduler: false });
  const server = studio.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await studio.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { authorization: 'Basic ' + Buffer.from('hec:' + password).toString('base64') };
  assert.equal((await fetch(base + '/api/config')).status, 401);
  const data = await (await fetch(base + '/api/config', { headers })).json();
  assert.deepEqual(data.styleProfiles.map(item => item.id), ['standard', 'late-night-drive']);
  const id = randomUUID(), at = clock().toISOString();
  const output = { filename: 'reel-1.mp4', cover: 'cover-1.jpg', caption: 'caption-1.txt', timeline: 'timeline-1.json', quality: 'quality-1.json', reviewSheets: ['review-1-sheet-001.jpg'] };
  await studio.store.create({ id, title: 'TEST', status: 'done', stage: 'TEST only', createdAt: at, updatedAt: at, options: { mode: 'quick' }, assets: [], outputs: [output] });
  const directory = path.join(studio.store.directory(id), 'outputs'); await fs.mkdir(directory, { recursive: true });
  for (const filename of ['timeline-1.json', 'quality-1.json', 'review-1-sheet-001.jpg', 'source-inventory.json', 'private.json']) await fs.writeFile(path.join(directory, filename), 'TEST-only artifact');
  for (const filename of ['timeline-1.json', 'quality-1.json', 'review-1-sheet-001.jpg', 'source-inventory.json']) {
    const url = `${base}/api/jobs/${id}/files/${filename}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url + '?download=1', { headers })).status, 200);
  }
  assert.equal((await fetch(`${base}/api/jobs/${id}/files/private.json`, { headers })).status, 404);
});
