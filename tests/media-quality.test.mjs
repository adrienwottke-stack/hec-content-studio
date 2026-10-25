import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSignalLog, timelineFor, timecode } from '../lib/media-quality.mjs';
import { getStyleProfile } from '../lib/style-profiles.mjs';
import { renderReel } from '../lib/media.mjs';

test('technical retries refuse a profile that drifted from the stored cut snapshot', async () => {
  const snapshot = structuredClone(getStyleProfile('late-night-drive'));
  snapshot.render.showHook = true;
  await assert.rejects(renderReel({}, 1, [], { styleProfile: 'late-night-drive', styleBrief: snapshot }, {}, '', undefined, async () => {}), /Stilprofil hat sich/);
});

test('FFmpeg diagnostic parsing preserves exact review positions and final loudness summary', () => {
  const log = `[blackdetect] black_start:2.04 black_end:2.32 black_duration:0.28
[freezedetect] freeze_start: 4.5
[freezedetect] freeze_duration: 2
[freezedetect] freeze_end: 6.5
[silencedetect] silence_start: 7.25
[silencedetect] silence_end: 8.75 | silence_duration: 1.5
I: -35.0 LUFS
Peak level dB: -2.7
Summary:
I: -24.2 LUFS
Peak: -2.4 dBFS`;
  const parsed = parseSignalLog(log);
  assert.deepEqual(parsed.black, [{ from: 2.04, to: 2.32, duration: 0.28 }]);
  assert.deepEqual(parsed.freeze, [{ from: 4.5, to: 6.5 }]);
  assert.deepEqual(parsed.silence, [{ from: 7.25, to: 8.75, duration: 1.5 }]);
  assert.equal(parsed.integratedLufs, -24.2);
  assert.equal(parsed.truePeakDbfs, -2.4);
  assert.equal(parsed.samplePeakDbfs, -2.7);
});

test('missing audio measurements remain unknown and open-ended warnings remain explicit', () => {
  const parsed = parseSignalLog('[freezedetect] freeze_start: 2.5\n[silencedetect] silence_start: 4.0');
  assert.equal(parsed.integratedLufs, null);
  assert.equal(parsed.truePeakDbfs, null);
  assert.equal(parsed.samplePeakDbfs, null);
  assert.deepEqual(parsed.freeze, [{ from: 2.5, to: null }]);
  assert.deepEqual(parsed.silence, [{ from: 4, to: null, duration: null }]);
});

test('saved timeline uses the selected source in/out positions and makes absent music explicit', () => {
  const reel = { title: 'Technischer Test', hook: 'Nicht einblenden', duration: 6.25, segments: [
    { assetId: 'one', from: 12.125, duration: 3.25, reason: 'Testauswahl', crop: { mode: 'fill', x: 0.2, y: 0.7, reason: 'Linke Testfläche' }, audio: { mode: 'original', gainDb: -3, reason: 'Synthetischer Testton' } },
    { assetId: 'two', from: 0.5, duration: 3, reason: 'Stumme Testquelle' }
  ] };
  const timeline = timelineFor(reel, [{ id: 'one', name: 'source-one.mp4', audio: true }, { id: 'two', name: 'source-two.mp4', audio: false }], { fit: 'preserve' }, getStyleProfile('late-night-drive'), null);
  assert.equal(timeline.textOverlay, null);
  assert.equal(timeline.music.status, 'not-supplied');
  assert.equal(timeline.music.replaceable, true);
  assert.equal(timeline.segments[0].sourceTimecodeIn, '00:00:12.125');
  assert.equal(timeline.segments[0].sourceTimecodeOut, '00:00:15.375');
  assert.equal(timeline.segments[1].timelineIn, 3.25);
  assert.equal(timeline.segments[1].timelineOut, 6.25);
  assert.equal(timeline.segments[0].crop.x, 0.2);
  assert.equal(timeline.segments[0].audio.gainDb, -3);
  assert.equal(timeline.segments[1].audio.sourceHasAudio, false);
  assert.equal(timecode(3661.999), '01:01:01.999');
});
