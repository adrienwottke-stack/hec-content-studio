import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio } from '../server.mjs';
import { configuration } from '../lib/config.mjs';
import { run } from '../lib/process.mjs';
import { probe } from '../lib/media.mjs';

// This creates an isolated, visibly labelled technical fixture. It does not edit
// user footage, fetch music, call an external model or publish anything.
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--work', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('Aufruf: node drive-smoke.mjs [--work ORDNER] [--output ORDNER]');
  options[args[i].slice(2)] = path.resolve(args[i + 1]);
}
const work = options.work || path.resolve('work/drive-smoke');
await fs.mkdir(work, { recursive: true });
const scratch = await fs.mkdtemp(path.join(work, 'run-')), dataDir = path.join(scratch, 'data'), sourcesDir = path.join(scratch, 'sources');
const outputDir = options.output || path.join(scratch, 'technical-validation');
await fs.mkdir(sourcesDir, { recursive: true }); await fs.mkdir(outputDir, { recursive: true });
const config = configuration({ DATA_DIR: dataDir, ANALYSIS_PROVIDER: 'codex', RENDER_WIDTH: '360', RENDER_FPS: '30', STUDIO_PASSWORD: 'local-synthetic-drive-contract' });
let font;
for (const candidate of ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf']) {
  try { await fs.access(candidate); font = candidate; break; } catch {}
}
if (!font) throw new Error('Für die sichtbare TECHNISCHER-TEST-Markierung fehlt eine lokale Schrift.');
await fs.copyFile(font, path.join(sourcesDir, 'fixture-font.ttf'));

async function makeSource(name, width, height, frequency, labelX) {
  const file = path.join(sourcesDir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`];
  if (frequency) args.push('-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`);
  args.push('-t', '4.6', '-vf', `drawtext=fontfile=fixture-font.ttf:text='TECHNISCHER TEST':fontsize=15:fontcolor=white:box=1:boxcolor=black@0.9:x=${labelX}:y=24`,
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p');
  if (frequency) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2'); else args.push('-an');
  args.push(file); await run(config.ffmpeg, args, { cwd: sourcesDir, timeout: 60_000 });
  return { file, name, width, height, audio: Boolean(frequency) };
}
console.error('TECHNISCHER TEST: drei beschriftete synthetische Quellen und ein eigener Testton werden erzeugt.');
const sources = [
  await makeSource('TECHNISCHER-TEST-quer-mit-ton.mp4', 640, 360, 440, 362),
  await makeSource('TECHNISCHER-TEST-hoch-ohne-ton.mp4', 360, 640, null, 16),
  await makeSource('TECHNISCHER-TEST-quer-stummzuschalten.mp4', 640, 360, 880, 100)
];
const musicFile = path.join(sourcesDir, 'TECHNISCHER-TEST-eigene-testmusik.wav');
await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
  '-t', '11', '-ac', '2', '-c:a', 'pcm_s16le', musicFile], { timeout: 30_000 });

let externalProviderCalls = 0;
const rejectExternal = () => { externalProviderCalls++; throw new Error('Externe Provider sind in diesem technischen Test gesperrt.'); };
const studio = await createStudio(config, { scheduler: false, planner: rejectExternal, cataloger: rejectExternal,
  statfs: async () => ({ blocks: 2 ** 30, bavail: 2 ** 29, bsize: 4096 }) });
const server = studio.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`, headers = { authorization: 'Basic ' + Buffer.from('hec:' + config.password).toString('base64'), 'x-reel-studio': '1' };
async function json(endpoint, body, method) {
  const response = await fetch(base + endpoint, { method: method || (body ? 'POST' : 'GET'), headers: { ...headers,
    ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.ok(response.ok, `${endpoint}: HTTP ${response.status}: ${result.error || 'Anfrage fehlgeschlagen'}`);
  return result;
}
async function wait(endpoint, statuses) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await json(endpoint);
    if (typeof statuses === 'function' ? statuses(result) : statuses.includes(result.status)) return result;
    await delay(200);
  }
  throw new Error(`Technischer Test: Zeitlimit beim Warten auf ${endpoint}`);
}
async function claim(kind, targetId) {
  const pending = (await json('/api/brain/work')).requests.find(item => item.kind === kind && item.targetId === targetId);
  assert.ok(pending, `Vorbereiteter ${kind}-Auftrag fehlt.`);
  return json(`/api/brain/${pending.id}/claim`, { worker: 'synthetic-drive-smoke' });
}
async function checkPrivateDownload(url) {
  assert.equal((await fetch(base + url)).status, 401);
  const response = await fetch(base + url, { headers }); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length > 100);
  return bytes;
}
async function download(url, filename) {
  const bytes = await checkPrivateDownload(url), file = path.join(outputDir, filename);
  await fs.writeFile(file, bytes); return file;
}
async function meanVolume(file, at) {
  const result = await run(config.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-ss', String(at), '-i', file, '-t', '1',
    '-vn', '-af', 'aformat=channel_layouts=stereo,volumedetect', '-f', 'null', '-'], { timeout: 30_000 });
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(result.stderr); assert.ok(match, 'Messbarer Audiopegel fehlt.');
  return Number(match[1]);
}
async function psnrAverage(rendered, source, sourceAt, cropX) {
  const filter = `[1:v]setpts=PTS-STARTPTS,scale=360:640:force_original_aspect_ratio=increase,crop=360:640:(in_w-out_w)*${cropX}:(in_h-out_h)*0.5,setsar=1[expected];[0:v]setpts=PTS-STARTPTS[actual];[actual][expected]psnr`;
  const result = await run(config.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'info', '-threads', '1', '-filter_complex_threads', '1',
    '-ss', '1', '-i', rendered, '-ss', String(sourceAt), '-i', source, '-filter_complex', filter, '-frames:v', '1', '-an', '-f', 'null', '-'], { timeout: 30_000 });
  const match = /average:([\d.]+|inf)/.exec(result.stderr); assert.ok(match, 'PSNR-Bildvergleich fehlt.');
  return match[1] === 'inf' ? 100 : Number(match[1]);
}
const report = { passed: false, scope: 'TECHNISCHER TEST mit erzeugten Testbildern und Testtönen. Kein echtes Fahrmaterial, kein ästhetisches Urteil und kein subjektiver Hörtest.',
  dataDir, outputDir, externalProviderCalls: 0, requestedDuration: 25, actualFixtureDuration: 9, branches: [],
  limitations: ['Die neun Sekunden prüfen den technischen Vertrag; sie sind kein 20–35-Sekunden-Schnittkonzept aus echtem Material.',
    'Automatisch vorbereitete Einzelbilder und Medien wurden technisch abgerufen; die Fixture ersetzt keine menschliche Sichtung und Anhörung.',
    'Kein Browsercheck, keine Instagram-Veröffentlichung und keine Zuschauerwirkung geprüft.'] };
try {
  const form = new FormData(); form.set('collection', 'TECHNISCHER TEST · Late Night Drive');
  form.set('brief', 'Ausschließlich synthetische Farbtafeln und Testtöne. Kein echtes Fahrzeug, kein echtes Ereignis.');
  for (const source of sources) form.append('videos', new Blob([await fs.readFile(source.file)], { type: 'video/mp4' }), source.name);
  const uploaded = await json('/api/library/uploads', form);
  assert.equal(uploaded.clips.length, 3);
  const ids = [];
  for (const source of sources) {
    const uploadedClip = uploaded.clips.find(item => item.name === source.name); assert.ok(uploadedClip);
    const clip = await wait('/api/library/' + uploadedClip.id, item => item.status === 'error' || item.analysisStatus === 'error' || item.status === 'ready' && item.analysisStatus === 'waiting-codex');
    assert.equal(clip.status, 'ready', clip.error || clip.stage); assert.equal(clip.analysisStatus, 'waiting-codex', clip.analysisError || clip.stage);
    assert.equal(clip.audio, source.audio); ids.push(clip.id);
    const lease = await claim('clip', clip.id); assert.ok(lease.assets[0].times.length >= 2);
    for (const sheet of lease.assets[0].sheetUrls) { const bytes = await checkPrivateDownload(sheet); assert.equal(bytes[0], 255); assert.equal(bytes[1], 216); }
    await json(`/api/brain/${lease.id}/complete`, { token: lease.token, result: {
      catalog: { title: 'TECHNISCHER TEST · synthetische Farbtafel', category: 'unsortiert', tags: ['Testmaterial'], description: 'Erzeugte Testbilder, kein echtes Fahrmaterial.', moments: [] },
      assessment: { use: 'unsuitable', reason: 'Nur eine technische Fixture, kein redaktionell brauchbares echtes Fahrmaterial.', nextStep: 'Echte Quellen separat hochladen.' },
      ideas: [], limitations: ['Automatisch gesetzte Testfixture, keine Modellbewertung oder ästhetische Freigabe.'] } });
  }
  for (const withMusic of [false, true]) {
    const label = withMusic ? 'mit-testmusik' : 'originalton', requestId = randomUUID(), sourceFrom = withMusic ? 0.55 : 0.5;
    console.error(`TECHNISCHER TEST: App-Workflow ${label}, Upload → Evidence → Plan → tatsächlicher Export.`);
    if (withMusic) {
      const response = await fetch(`${base}/api/music/${requestId}`, { method: 'PUT', headers: { ...headers,
        'Content-Type': 'application/octet-stream', 'x-music-name': encodeURIComponent(path.basename(musicFile)) }, body: await fs.readFile(musicFile) });
      assert.equal(response.status, 200, 'Eigene synthetische Testmusik konnte nicht angehängt werden.');
    }
    const created = await json('/api/jobs/from-library', { requestId, assetIds: ids, title: `TECHNISCHER TEST · ${label}`, brief: report.scope,
      count: 1, duration: 25, goal: 'atmosphere', fit: 'fill', styleProfile: 'late-night-drive', ...(withMusic ? { musicId: requestId } : {}) });
    const waiting = await wait('/api/jobs/' + created.id, ['waiting-brain', 'error']); assert.equal(waiting.status, 'waiting-brain', waiting.error || waiting.stage);
    const lease = await claim('job', created.id); assert.equal(lease.options.styleProfile, 'late-night-drive');
    const segments = ids.map((id, i) => {
      const asset = lease.assets.find(item => item.id === id); assert.ok(asset);
      const visualTimes = asset.times.filter(at => at >= sourceFrom && at <= sourceFrom + 3).slice(0, 2);
      assert.equal(visualTimes.length, 2, 'Zwei tatsächlich vorbereitete Bilder müssen innerhalb der Auswahl liegen.');
      assert.ok(asset.mediaUrls?.preview, 'Late Night Drive muss eine abspielbare Quellsequenz vorbereiten.');
      return { assetId: id, from: sourceFrom, duration: 3, reason: 'TECHNISCHER TEST: drei Sekunden einer beschrifteten synthetischen Quelle.',
        crop: { mode: i === 1 ? 'preserve' : 'fill', x: i === 0 ? 0.8 : i === 2 ? 0.2 : 0.5, y: 0.5, reason: 'TECHNISCHER TEST: kontrollierter Ausschnitt für den Vergleich.' },
        audio: { mode: i === 2 ? 'mute' : 'original', gainDb: i === 0 ? -6 : 0, reason: 'TECHNISCHER TEST: Quellton absenken, fehlenden Ton auffüllen oder vorhandenen Testton stummschalten.' },
        evidence: { visualTimes, motion: 'Synthetische Farbtafel mit generierter Bewegung, keine beobachtete Fahrt.', light: 'Generierte Testfarben, keine echte Nachtaufnahme.',
          stability: 'Computergenerierte Fixture ohne Kameraaussage.', sound: 'Testton laut Generator vorhanden oder Quelle ohne Audiostream; kein subjektiver Hörtest.',
          audioBasis: 'not-listened', limitations: ['Technischer Test, keine tatsächliche Inhalts- oder Geräuschbewertung.'] } };
    });
    for (const asset of lease.assets) {
      await checkPrivateDownload(asset.mediaUrls.preview);
      if (asset.mediaUrls.audio) await checkPrivateDownload(asset.mediaUrls.audio);
    }
    const brief = lease.options.productionBrief;
    const plan = { summary: `${report.scope} Zielwert 25 s; bewusst nur 9 s Testfixture zur Prüfung von drei Entscheidungen.`, reels: [{
      title: `TECHNISCHER TEST · ${label}`, hook: 'DIESER TEST-HOOK DARF NICHT EINGEBLENDET WERDEN', caption: report.scope,
      hypothesis: 'Technischer Vertrag für Stilprofil, Quellzeitmarken, Ausschnitt, Ton und Export. Keine Aussage zur Zuschauerreaktion.', segments,
      features: { topic: 'TECHNISCHER TEST', opening: 'Generierte Farbtafel', action: 'Generierte Bewegung', cut: 'Drei einfache Schnitteinstellungen zu je drei Sekunden',
        sound: withMusic ? 'Eigener synthetischer Testton unter Quellton' : 'Synthetischer Quellton; zwei kontrollierte stille Abschnitte', text: 'Kein automatischer Text; TECHNISCHER TEST ist in den synthetischen Quellen markiert.', expectedReaction: 'Nur technische Prüfung, keine Wirkungsbehauptung' },
      briefingApplied: [{ sourceId: brief.style.id, change: 'TECHNISCHER TEST: persönliche Stilvorgabe ist auf Testbilder nicht anwendbar. Late-Night-Drive-Vertrag separat technisch geprüft.' },
        ...brief.learnings.map(learning => ({ sourceId: learning.id, change: 'TECHNISCHER TEST: Prozessanforderung an vorhandene Übersichten und Quellenbelege berücksichtigt; technische Bereitstellung geprüft. Persönliche Ästhetik und Wirkung bleiben unbewertet.' }))] }] };
    const completed = await json(`/api/brain/${lease.id}/complete`, { token: lease.token, result: plan }); assert.equal(completed.ok, true);
    assert.equal((await json(`/api/brain/${lease.id}/complete`, { token: lease.token, result: plan })).idempotent, true);
    const rendered = await wait('/api/jobs/' + created.id, ['done', 'error']); assert.equal(rendered.status, 'done', rendered.error || rendered.stage);
    const output = rendered.outputs[0]; assert.equal(output.styleProfile, 'late-night-drive'); assert.equal(output.qa.technical, 'passed');
    const prefix = `TECHNISCHER-TEST-${label}`;
    const mp4 = await download(output.videoUrl, prefix + '.mp4');
    const timelineFile = await download(`/api/jobs/${created.id}/files/${output.timeline}`, prefix + '-timeline.json');
    const qualityFile = await download(`/api/jobs/${created.id}/files/${output.quality}`, prefix + '-quality.json');
    const planFile = await download(`/api/jobs/${created.id}/files/plan.json`, prefix + '-plan.json');
    const inventoryFile = await download(`/api/jobs/${created.id}/files/source-inventory.json`, prefix + '-source-inventory.json');
    const cover = await download(output.coverUrl, prefix + '-cover.jpg');
    const reviewSheets = [];
    for (const [i, sheet] of output.reviewSheets.entries()) reviewSheets.push(await download(`/api/jobs/${created.id}/files/${sheet}`, prefix + `-review-${i + 1}.jpg`));
    const timeline = JSON.parse(await fs.readFile(timelineFile, 'utf8')), quality = JSON.parse(await fs.readFile(qualityFile, 'utf8'));
    const inventory = JSON.parse(await fs.readFile(inventoryFile, 'utf8'));
    for (let i = 0; i < sources.length; i++) {
      const sourceSha256 = createHash('sha256').update(await fs.readFile(sources[i].file)).digest('hex');
      assert.equal(inventory.sources.find(item => item.id === ids[i])?.sha256, sourceSha256);
      assert.equal(timeline.segments.find(item => item.assetId === ids[i])?.sourceSha256, sourceSha256);
    }
    assert.equal(timeline.textOverlay, null); assert.equal(timeline.segments[0].crop.x, 0.8); assert.equal(timeline.segments[0].audio.gainDb, -6);
    assert.equal(timeline.segments[1].audio.sourceHasAudio, false); assert.equal(timeline.segments[2].audio.mode, 'mute');
    assert.equal(timeline.music.status, withMusic ? 'user-supplied' : 'not-supplied'); assert.equal(quality.signals.fullDecode, 'passed');
    assert.equal(quality.aesthetic, 'pending-review');
    const metadata = await probe(mp4, config); assert.equal(metadata.width, 360); assert.equal(metadata.height, 640); assert.equal(metadata.audio, true);
    assert.ok(Math.abs(metadata.duration - 9) < 0.1);
    const timingProbe = await run(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time,duration,nb_frames,avg_frame_rate', '-of', 'json', mp4], { timeout: 30_000 });
    const videoTiming = JSON.parse(timingProbe.stdout).streams[0];
    assert.ok(Math.abs(Number(videoTiming.start_time)) <= 0.001, 'Videobeginn muss auf dem Timelinebeginn liegen.');
    assert.ok(Math.abs(Number(videoTiming.duration) - 9) < 0.1, 'Videospur muss die geplante Dauer abdecken.');
    assert.equal(Number(videoTiming.nb_frames), 9 * config.fps, 'Konstante Bildrate muss genau zur geplanten Bildanzahl passen.');
    const levels = { first: await meanVolume(mp4, 0.5), noSourceAudio: await meanVolume(mp4, 3.5), mutedSource: await meanVolume(mp4, 6.5) };
    if (withMusic) { assert.ok(levels.noSourceAudio > -75); assert.ok(levels.mutedSource > -75); }
    else {
      levels.source = await meanVolume(sources[0].file, sourceFrom + 0.5);
      assert.ok(Math.abs((levels.first - levels.source) - -6) < 1.5, 'Absenkung um -6 dB muss im Export messbar sein.');
      assert.ok(levels.noSourceAudio < -75); assert.ok(levels.mutedSource < -75);
    }
    const cropPsnr = { selected: await psnrAverage(mp4, sources[0].file, sourceFrom + 1, 0.8), center: await psnrAverage(mp4, sources[0].file, sourceFrom + 1, 0.5) };
    assert.ok(cropPsnr.selected > 26 && cropPsnr.selected > cropPsnr.center + 6, 'Gerenderter Ausschnitt muss zur gewählten Position passen und ohne Hook dem Quellbild entsprechen.');
    assert.equal((await fetch(base + output.videoUrl, { headers: { ...headers, range: 'bytes=0-1023' } })).status, 206);
    report.branches.push({ label, jobId: created.id, duration: metadata.duration, mp4, timeline: timelineFile, quality: qualityFile, plan: planFile,
      sourceInventory: inventoryFile, cover, reviewSheets, videoTiming, audioMeanDbfs: levels, cropPsnr, technical: quality.technical, aesthetic: quality.aesthetic });
  }
  assert.equal(externalProviderCalls, 0); report.externalProviderCalls = externalProviderCalls; report.passed = true;
  report.checks = ['echter Upload in isolierte App', 'drei echte synthetische Dateien mit Quer-/Hochformat und Ton/ohne Ton', 'private vorbereitete Bilder, Quellsequenzen und Originaltondateien',
    'tatsächlich vorbereitete Quellzeitmarken im validierten Plan', 'Claim und idempotente Planübergabe', 'zwei tatsächliche H.264/AAC-Exporte mit 360×640 und 9 Sekunden',
    'Off-Center-Ausschnitt und fehlender Hook im Bildvergleich', 'Originalton-Absenkung und stumme Szenen als Pegelmessung', 'eigene Testmusik im zweiten Export',
    'vollständiger Decode und technische Signalmessung', 'private Timeline-/QA-/Plan-/MP4-Downloads und HTTP-Bytebereiche'];
  await fs.writeFile(path.join(outputDir, 'TECHNISCHER-TEST-drive-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await studio.close(); await new Promise(resolve => server.close(resolve));
  // Keep this run's isolated DATA_DIR and files for subsequent browser review.
}
