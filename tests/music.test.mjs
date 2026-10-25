import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { configuration } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { normalizeMusicId, resolveMusic } from '../lib/music.mjs';

const scratch = fileURLToPath(new URL('../../../work/tests/', import.meta.url));

test('an optional music reference remains optional while invalid and missing files are rejected', async () => {
  assert.equal(normalizeMusicId(), undefined);
  assert.equal(await resolveMusic({}, undefined), null);
  for (const value of ['../private', 'not-a-uuid', {}, 2, ['file']]) assert.throws(() => normalizeMusicId(value), /Musikdatei-Referenz/);
  await assert.rejects(() => resolveMusic({ dataDir: scratch }, randomUUID()), /Musikdatei fehlt/);
});

test('real synthetic audio upload is private, verified, idempotent, immutable and free of public paths or keys', async t => {
  await fs.mkdir(scratch, { recursive: true });
  const directory = await fs.mkdtemp(path.join(scratch, 'music-http-'));
  let studio, server;
  t.after(async () => {
    if (studio) await studio.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(scratch) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = configuration({ DATA_DIR: directory, STUDIO_PASSWORD: 'ONLY-LOCAL-MUSIC-CONTRACT-TEST' });
  const fixtures = [];
  for (const frequency of [440, 880]) {
    const file = path.join(directory, `TECHNISCHER-TEST-${frequency}.wav`);
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
      '-t', '0.8', '-ac', '2', '-c:a', 'pcm_s16le', file], { timeout: 30_000 });
    fixtures.push(await fs.readFile(file));
  }
  studio = await createStudio(config, { scheduler: false });
  server = studio.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, id = randomUUID();
  const headers = { authorization: 'Basic ' + Buffer.from('hec:' + config.password).toString('base64'), 'x-reel-studio': '1',
    'Content-Type': 'application/octet-stream', 'x-music-name': encodeURIComponent('TECHNISCHER TEST · eigener Testton.wav') };
  const put = (reference, body = fixtures[0], changes = {}) => fetch(`${base}/api/music/${reference}`, { method: 'PUT', headers: { ...headers, ...changes }, body });
  assert.equal((await put(id, fixtures[0], { authorization: '' })).status, 401);
  assert.equal((await put(id, fixtures[0], { 'x-reel-studio': '' })).status, 403);
  assert.equal((await put(id, fixtures[0], { origin: 'https://unrelated.invalid' })).status, 403);
  const first = await put(id), firstRecord = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstRecord));
  assert.equal(firstRecord.id, id); assert.ok(firstRecord.duration >= 0.79 && firstRecord.duration <= 0.81);
  assert.equal(firstRecord.sha256, createHash('sha256').update(fixtures[0]).digest('hex'));
  assert.equal(firstRecord.rights, 'user-supplied-unverified');
  const publicJson = JSON.stringify(firstRecord);
  for (const forbidden of ['path', 'token', 'apiKey', 'password']) assert.equal(Object.hasOwn(firstRecord, forbidden), false);
  assert.ok(!publicJson.includes(config.password)); assert.ok(!publicJson.includes(directory));
  const resolved = await resolveMusic(config, id);
  assert.deepEqual(await fs.readFile(resolved.path), fixtures[0]);
  const again = await put(id); assert.equal(again.status, 200); assert.deepEqual(await again.json(), firstRecord);
  const conflict = await put(id, fixtures[1]); assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /anderen Musikdatei/);
  assert.deepEqual(await fs.readFile((await resolveMusic(config, id)).path), fixtures[0]);
  const nonAudioId = randomUUID(), invalidAudio = await put(nonAudioId, Buffer.from('TECHNISCHER TEST: no audio payload'));
  assert.equal(invalidAudio.status, 400); assert.ok(!(await invalidAudio.text()).includes(directory));
  await assert.rejects(() => resolveMusic(config, nonAudioId), /fehlt/);
  assert.equal((await put('invalid-music-id')).status, 400);
  assert.equal((await fetch(base + '/api/music/', { method: 'PUT', headers, body: fixtures[0] })).status, 404);
  assert.equal((await put(randomUUID(), fixtures[0], { 'Content-Type': 'text/plain' })).status, 400);
});
