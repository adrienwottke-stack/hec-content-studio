import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.mjs';

const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
export function parseSignalLog(log) {
  const black = [...log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
    .map(match => ({ from: Number(match[1]), to: Number(match[2]), duration: Number(match[3]) }));
  const silence = [];
  let silenceStart;
  for (const line of log.split('\n')) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) silenceStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (end) { silence.push({ from: silenceStart ?? Math.max(0, Number(end[1]) - Number(end[2])), to: Number(end[1]), duration: Number(end[2]) }); silenceStart = undefined; }
  }
  const freeze = [];
  let freezeStart;
  for (const line of log.split('\n')) {
    const start = line.match(/freeze_start:\s*([\d.]+)/);
    if (start) freezeStart = Number(start[1]);
    const end = line.match(/freeze_end:\s*([\d.]+)/);
    if (end && freezeStart !== undefined) { freeze.push({ from: freezeStart, to: Number(end[1]) }); freezeStart = undefined; }
  }
  if (freezeStart !== undefined) freeze.push({ from: freezeStart, to: null });
  if (silenceStart !== undefined) silence.push({ from: silenceStart, to: null, duration: null });
  const last = regex => { const matches = [...log.matchAll(regex)]; return matches.length ? number(matches.at(-1)[1]) : null; };
  return { black, freeze, silence,
    integratedLufs: last(/\bI:\s*(-?[\d.]+)\s+LUFS/g),
    truePeakDbfs: last(/\bPeak:\s*(-?[\d.]+)\s+dBFS/g),
    samplePeakDbfs: last(/Peak level dB:\s*(-?[\d.]+)/g) };
}

export async function inspectSignals(file, metadata, config, signal) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-xerror', '-threads', '1', '-filter_threads', '1', '-i', file,
    '-map', '0:v:0', '-vf', 'blackdetect=d=0.15:pix_th=0.04:pic_th=0.98,freezedetect=n=-55dB:d=1.5'];
  if (metadata.audio) args.push('-map', '0:a:0', '-af', 'silencedetect=noise=-50dB:d=0.3,astats=metadata=0:reset=0,ebur128=peak=true:framelog=verbose');
  args.push('-f', 'null', '-');
  const result = await run(config.ffmpeg, args, { signal, timeout: 600_000, stderrLimit: 250_000 });
  const signals = parseSignalLog(result.stderr);
  return { fullDecode: 'passed', diagnosticCoverage: result.stderrTruncated ? 'partial-log' : 'complete-log', ...signals,
    notice: 'Technische Signalprüfung. Dunkle Nachtbilder, ruhige Einstellungen und Stille sind Hinweise zur Sichtung und werden nicht automatisch verworfen. Keine Aussage über Geräuschquelle, Ästhetik oder Zuschauerwirkung.' };
}

export async function createReviewSheets(file, duration, directory, index, config, signal) {
  const frameDir = path.join(directory, `review-frames-${index}`);
  await fs.mkdir(frameDir, { recursive: true });
  const count = Math.min(16, Math.max(2, Math.ceil(duration)));
  const times = Array.from({ length: count }, (_, i) => Math.round(Math.max(0, duration - 0.1) * i / (count - 1) * 1000) / 1000);
  try {
    for (let i = 0; i < times.length; i++) await run(config.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1', '-ss', String(times[i]), '-i', file,
      '-frames:v', '1', '-vf', 'scale=180:320', '-q:v', '3', path.join(frameDir, `frame-${String(i + 1).padStart(3, '0')}.jpg`),
    ], { signal, timeout: 45_000 });
    const filename = `review-${index}-sheet-001.jpg`;
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1', '-framerate', '1',
      '-i', path.join(frameDir, 'frame-%03d.jpg'), '-vf', `tile=4x4:nb_frames=${count}:padding=4:margin=4:color=0x152336`,
      '-frames:v', '1', '-q:v', '3', path.join(directory, filename)], { signal, timeout: 60_000 });
    return { files: [filename], times, coverage: 'sampled-rendered-frames', notice: 'Einzelbildstichproben des tatsächlich gerenderten Films; Rhythmus und subjektiver Klang brauchen zusätzlich eine zeitliche Sichtung beziehungsweise Anhörung.' };
  } finally { await fs.rm(frameDir, { recursive: true, force: true }); }
}

export function timecode(seconds) {
  const ms = Math.round(seconds * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

export function timelineFor(reel, assets, options, profile, music) {
  const sourceMap = new Map(assets.map(asset => [asset.id, asset]));
  let position = 0;
  return { title: reel.title, styleProfile: profile.id, duration: reel.duration,
    textOverlay: profile.render.showHook ? reel.hook : null,
    colour: 'Quellfarben ohne Aufhellung, Sättigung, Schärfung oder LUT; nur der unscharfe Hintergrund bei preserve wird abgedunkelt.',
    music: music ? { status: 'user-supplied', filename: music.name, sha256: music.sha256, gainDb: profile.render.musicGainDb ?? -24, rights: music.rights, loop: false,
      timelineIn: 0, timelineOut: Math.min(music.duration, reel.duration), fadeInSeconds: Math.min(1, Math.min(music.duration, reel.duration) / 3),
      fadeOutFrom: Math.min(music.duration, reel.duration) - Math.min(1, Math.min(music.duration, reel.duration) / 3), fadeOutSeconds: Math.min(1, Math.min(music.duration, reel.duration) / 3) } :
      { status: 'not-supplied', replaceable: true, instruction: 'Optional eigene nutzbare Audiodatei im Sessionformular wählen. Dieser Export verwendet ausschließlich die Quelltonspuren; keine Musik wurde beschafft.' },
    segments: reel.segments.map((segment, i) => {
      const asset = sourceMap.get(segment.assetId), from = position;
      position = Math.round((position + segment.duration) * 1000) / 1000;
      const sourceOut = Math.round((segment.from + segment.duration) * 1000) / 1000;
      return { scene: i + 1, timelineIn: from, timelineOut: position, timelineTimecodeIn: timecode(from), timelineTimecodeOut: timecode(position),
        assetId: segment.assetId, filename: asset.name, sourceSha256: asset.sha256 || null, sourceIn: segment.from, sourceOut, sourceTimecodeIn: timecode(segment.from), sourceTimecodeOut: timecode(sourceOut),
        crop: segment.crop || { mode: options.fit || 'preserve', x: 0.5, y: 0.5, reason: 'Globale Bildoption.' },
        audio: { mode: segment.audio?.mode || 'original', gainDb: segment.audio?.gainDb ?? 0, reason: segment.audio?.reason || 'Originalton der gewählten Quelle.', sourceHasAudio: Boolean(asset.audio), fadeSeconds: Math.min(profile.render.audioFadeSeconds || 0, segment.duration / 3) },
        transition: 'cut', reason: segment.reason, evidence: segment.evidence || null };
    }) };
}
