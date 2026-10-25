import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchema, validatePlan, quickPlan } from '../lib/plan.mjs';

const assets = [{ id: 'drive-source', name: 'source.mp4', duration: 120, width: 1920, height: 1080, audio: true }];
const options = { styleProfile: 'late-night-drive' };
function segment(from = 1, duration = 4) {
  return {
    assetId: 'drive-source', from, duration, reason: 'Ruhige beobachtete Bewegung im gewählten Abschnitt.',
    crop: { mode: 'preserve', x: 0.5, y: 0.5, reason: 'Der vollständige Quellrahmen bleibt sichtbar.' },
    audio: { mode: 'original', gainDb: 0, reason: 'Originalton erhalten; Hörprüfung steht noch aus.' },
    evidence: {
      visualTimes: [from, from + duration - 0.1],
      motion: 'Zwei Stichproben zeigen die beurteilten Bildpositionen.',
      light: 'Licht und Farben müssen anhand der echten Stichproben beurteilt werden.',
      stability: 'Stichproben belegen keine lückenlose Bewegungsstabilität.',
      sound: 'Originalton noch nicht angehört; keine Geräusche daraus behauptet.',
      audioBasis: 'not-listened', limitations: ['Technischer Schematest ohne echte Nachtfahrt.'],
    },
  };
}
function plan() {
  return {
    summary: 'Technischer Schematest. Die kurze Auswahl ist keine Materialbewertung.',
    reels: [{ title: 'Late Night Drive', hook: '', caption: 'Technischer Test.',
      hypothesis: 'Keine Zuschauerwirkung gemessen.', segments: [segment()] }],
  };
}
const validate = raw => validatePlan(raw, assets, 1, options);

test('legacy cuts retain their shape, hook requirement and explicit quick-mode label', () => {
  const raw = plan();
  raw.reels[0].hook = 'Ein echter Moment';
  delete raw.reels[0].segments[0].crop;
  delete raw.reels[0].segments[0].audio;
  delete raw.reels[0].segments[0].evidence;
  const result = validatePlan(raw, assets);
  assert.deepEqual(result.reels[0].segments[0], raw.reels[0].segments[0]);
  raw.reels[0].hook = '';
  assert.throws(() => validatePlan(raw, assets), /Einstieg/);
  assert.match(quickPlan(assets, 10).summary, /keine KI/);
  assert.deepEqual(planSchema.properties.reels.items.properties.segments.items.required, ['assetId', 'from', 'duration', 'reason']);
});

test('drive cuts keep validated crop, source audio and explicit evidence limitations without hook text', () => {
  const result = validate(plan());
  const selected = result.reels[0].segments[0];
  assert.equal(result.reels[0].hook, '');
  assert.deepEqual(selected.crop, segment().crop);
  assert.deepEqual(selected.audio, segment().audio);
  assert.deepEqual(selected.evidence, segment().evidence);
  assert.equal(result.reels[0].duration, 4);
});

test('identical source bytes under different upload IDs cannot bypass the drive repetition check', () => {
  const raw = plan();
  raw.reels[0].segments.push({ ...segment(), assetId: 'same-bytes-other-id' });
  const sameBytes = [
    { ...assets[0], sha256: 'same-source-hash' },
    { ...assets[0], id: 'same-bytes-other-id', sha256: 'same-source-hash' },
  ];
  assert.throws(() => validatePlan(raw, sameBytes, 1, options), /überlappenden/);
});

test('profile names are validated and missing drive decisions cannot silently fall back', () => {
  assert.throws(() => validatePlan(plan(), assets, 1, { styleProfile: '../../custom-profile' }));
  for (const field of ['crop', 'audio', 'evidence']) {
    const raw = plan(); delete raw.reels[0].segments[0][field];
    assert.throws(() => validate(raw), /pro Szene/);
  }
});

test('crop positions and modes are bounded data; horizontal fill needs a concrete reason', async t => {
  for (const [field, value] of [['x', -0.01], ['x', 1.01], ['y', NaN], ['y', Infinity], ['x', '0.5'], ['mode', 'filter']]) {
    await t.test(`${field}=${String(value)}`, () => {
      const raw = plan(); raw.reels[0].segments[0].crop[field] = value;
      assert.throws(() => validate(raw), /Ausschnitt/);
    });
  }
  const missingReason = plan();
  missingReason.reels[0].segments[0].crop = { mode: 'fill', x: 0.8, y: 0.4, reason: '' };
  assert.throws(() => validate(missingReason), /Ausschnittbegründung/);
  const fill = plan();
  fill.reels[0].segments[0].crop = { mode: 'fill', x: 0.8, y: 0.4, reason: 'Gewähltes Motiv bleibt an beiden belegten Zeitpunkten im Hochformatausschnitt.' };
  assert.equal(validate(fill).reels[0].segments[0].crop.x, 0.8);
  const injected = plan(); injected.reels[0].segments[0].crop.filter = 'movie=private';
  assert.throws(() => validate(injected), /Bildausschnitt/);
});

test('audio choices allow only bounded original volume or explicit muting', () => {
  for (const gain of [-24.01, 6.01, Infinity, NaN, '0']) {
    const raw = plan(); raw.reels[0].segments[0].audio.gainDb = gain;
    assert.throws(() => validate(raw), /Originaltonverstärkung/);
  }
  const injected = plan(); injected.reels[0].segments[0].audio.path = '../fake-engine.wav';
  assert.throws(() => validate(injected), /Audioentscheidung/);
  const fake = plan(); fake.reels[0].segments[0].audio.mode = 'generated-engine';
  assert.throws(() => validate(fake), /Audiomodus/);
  const muted = plan();
  muted.reels[0].segments[0].audio = { mode: 'mute', gainDb: -24, reason: 'Unerwünschte Tonpassage nach Hörprüfung auslassen.' };
  assert.equal(validate(muted).reels[0].segments[0].audio.mode, 'mute');
});

test('drive evidence needs two different source times inside the selected interval', () => {
  for (const visualTimes of [[], [1], [1, 1], [1, 1.00001], [0.999, 2], [2, 5.001], [2, 121], [2, Infinity], [2, '3']]) {
    const raw = plan(); raw.reels[0].segments[0].evidence.visualTimes = visualTimes;
    assert.throws(() => validate(raw), /Bildmark/);
  }
  const clipped = plan(); clipped.reels[0].segments[0] = segment(119, 1.05);
  clipped.reels[0].segments[0].evidence.visualTimes = [119, 120.01];
  assert.throws(() => validate(clipped), /Bildmark/);
  const edges = plan(); edges.reels[0].segments[0].evidence.visualTimes = [1, 5];
  assert.deepEqual(validate(edges).reels[0].segments[0].evidence.visualTimes, [1, 5]);
});

test('evidence text, listening status and limitations remain bounded and explicit', () => {
  for (const field of ['motion', 'light', 'stability', 'sound']) {
    const missing = plan(); missing.reels[0].segments[0].evidence[field] = '';
    assert.throws(() => validate(missing));
    const oversized = plan(); oversized.reels[0].segments[0].evidence[field] = 'x'.repeat(451);
    assert.throws(() => validate(oversized));
  }
  const tooMany = plan(); tooMany.reels[0].segments[0].evidence.limitations = Array(9).fill('Offen.');
  assert.throws(() => validate(tooMany), /acht Einschränkungen/);
  const unknownBasis = plan(); unknownBasis.reels[0].segments[0].evidence.audioBasis = 'transcript-only';
  assert.throws(() => validate(unknownBasis), /Tonbeobachtung/);
  const injected = plan(); injected.reels[0].segments[0].evidence.command = 'read private';
  assert.throws(() => validate(injected), /Szenenbelege/);
});

test('drive cuts reject repeated source windows while allowing contiguous, distinct moments', () => {
  for (const secondFrom of [1, 3, 0]) {
    const repeated = plan(); repeated.reels[0].segments.push(segment(secondFrom));
    assert.throws(() => validate(repeated), /überlappenden/);
  }
  const contiguous = plan(); contiguous.reels[0].segments.push(segment(5));
  assert.equal(validate(contiguous).reels[0].duration, 8);
  const legacy = plan(); legacy.reels[0].hook = 'Vorhandener Stil'; legacy.reels[0].segments.push(segment(1));
  assert.equal(validatePlan(legacy, assets).reels[0].duration, 8);
});

test('the 20–35 second target is editorial guidance; source and 60 second limits still apply', () => {
  assert.equal(validate(plan()).reels[0].duration, 4);
  const longer = plan();
  longer.summary = 'Technischer Grenztest; eine längere echte Fassung bräuchte eine materialbezogene Begründung.';
  longer.reels[0].segments = [segment(0, 13), segment(13, 13), segment(26, 13)];
  assert.equal(validate(longer).reels[0].duration, 39);
  const tooLong = plan(); tooLong.reels[0].segments = [0, 13, 26, 39, 52].map(from => segment(from, 13));
  assert.throws(() => validate(tooLong), /60/);
  const outside = plan(); outside.reels[0].segments[0].from = 119;
  assert.throws(() => validate(outside), /außerhalb/);
});

test('source cut times and evidence times use millisecond precision', () => {
  const raw = plan();
  raw.reels[0].segments[0] = segment(1.23449, 4.56749);
  raw.reels[0].segments[0].evidence.visualTimes = [1.23449, 5.7];
  const selected = validate(raw).reels[0].segments[0];
  assert.equal(selected.from, 1.234);
  assert.equal(selected.duration, 4.567);
  assert.deepEqual(selected.evidence.visualTimes, [1.234, 5.7]);
});
