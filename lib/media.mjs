import path from 'node:path';
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { run } from './process.mjs';
import { getStyleProfile } from './style-profiles.mjs';
import { resolveMusic } from './music.mjs';
import { inspectSignals, createReviewSheets, timelineFor } from './media-quality.mjs';

export async function probe(file, config, signal) {
  const result = await run(config.ffprobe, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { signal, timeout: 30_000 });
  const data = JSON.parse(result.stdout);
  const video = data.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const duration = Number(data.format?.duration ?? video?.duration);
  if (!video || !Number.isFinite(duration) || duration < 0.5 || !video.width || !video.height) {
    throw new Error('Die Datei enthält keine lesbare Videoaufnahme mit mindestens einer halben Sekunde.');
  }
  const rotation = Number(video.side_data_list?.find(side => side.rotation !== undefined)?.rotation || video.tags?.rotate || 0);
  const rotated = Math.abs(rotation % 180) === 90;
  const ratio = value => { const [n, d = '1'] = String(value || '').split('/').map(Number); return Number.isFinite(n / d) && n / d > 0 ? n / d : null; };
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  return {
    duration, width: rotated ? video.height : video.width, height: rotated ? video.width : video.height,
    audio: Boolean(audio), fps: ratio(video.avg_frame_rate) || ratio(video.r_frame_rate),
    frameRate: video.avg_frame_rate || video.r_frame_rate || null, timeBase: video.time_base || null,
    videoStartTime: Number(video.start_time) || 0, videoDuration: Number(video.duration) || duration,
    frameCount: Number(video.nb_frames) || null,
    videoCodec: video.codec_name || null, pixelFormat: video.pix_fmt || null, rotation,
    colour: { space: video.color_space || null, transfer: video.color_transfer || null, primaries: video.color_primaries || null, range: video.color_range || null },
    audioInfo: audio ? { codec: audio.codec_name || null, channels: Number(audio.channels) || null, sampleRate: Number(audio.sample_rate) || null } : null,
  };
}

export async function createProxy(asset, output, config, signal) {
  await run(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1', '-i', asset.path,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(640,iw)':-2,fps=12,setsar=1",
    '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '29', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', output,
  ], { signal });
}

function wrapHook(value, columns = 25) {
  // ASS override codes never come from provider or user text.
  const words = value.replace(/[\\{}\r\n]/g, ' ').split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > columns) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).join('\\N');
}

export function hookSubtitle(hook, width, height, duration) {
  const fontSize = Math.round(width * 0.066);
  const margin = Math.round(height * 0.14);
  const end = `0:00:${Math.min(duration, 4).toFixed(2).padStart(5, '0')}`;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Hook,DejaVu Sans,${fontSize},&H00FFFFFF,&H00FFFFFF,&H001B1B1B,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,8,64,64,${margin},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${end},Hook,,0,0,0,,${wrapHook(hook)}\n`;
}

export async function renderReel(reel, index, assets, options, config, directory, signal, report) {
  const profile = getStyleProfile(options.styleProfile);
  if (options.styleBrief && !isDeepStrictEqual(options.styleBrief, profile)) throw new Error('Das Stilprofil hat sich seit dem gespeicherten Schnittplan geändert. Für neue Vorgaben eine neue Schnittversion anlegen.');
  const music = await resolveMusic(config, options.musicId);
  const width = config.width - config.width % 2;
  const height = Math.round(width * 16 / 9 / 2) * 2;
  const sourceMap = new Map(assets.map(asset => [asset.id, asset]));
  const sourceHasAudio = reel.segments.some(segment => sourceMap.get(segment.assetId)?.audio);
  const partsDir = path.join(directory, `parts-${index}`);
  await fs.mkdir(partsDir, { recursive: true });
  const filenames = [];
  for (let i = 0; i < reel.segments.length; i++) {
    signal?.throwIfAborted();
    const segment = reel.segments[i];
    const asset = sourceMap.get(segment.assetId);
    if (profile.id === 'late-night-drive' && ['smpte2084', 'arib-std-b67'].includes(asset.colour?.transfer)) {
      throw new Error('Diese Quelle ist HDR. Für natürliche Nachtfarben zuerst eine ausdrücklich geprüfte SDR-Fassung bereitstellen; automatisches Tone-Mapping ist nicht eingerichtet.');
    }
    await report(`Reel ${index}: Szene ${i + 1} von ${reel.segments.length} wird geschnitten.`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_complex_threads', '1', '-ss', String(segment.from), '-i', asset.path];
    if (!asset.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    const crop = segment.crop || { mode: options.fit, x: 0.5, y: 0.5 };
    const filter = crop.mode === 'fill'
      ? `[0:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(in_w-out_w)*${crop.x ?? 0.5}:(in_h-out_h)*${crop.y ?? 0.5},setsar=1,fps=${config.fps}[video]`
      : `[0:v]setpts=PTS-STARTPTS,split[background][foreground];[background]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=24,eq=brightness=-0.12[bg];[foreground]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${config.fps}[video]`;
    const filename = `segment-${String(i).padStart(3, '0')}.mp4`;
    filenames.push(filename);
    const gain = segment.audio?.mode === 'mute' ? 'volume=0' : `volume=${segment.audio?.gainDb ?? 0}dB`;
    const fade = Math.min(profile.render.audioFadeSeconds || 0, segment.duration / 3);
    const audioFilter = ['asetpts=PTS-STARTPTS', 'aresample=48000', gain, ...(fade ? [`afade=t=in:d=${fade}`, `afade=t=out:st=${Math.max(0, segment.duration - fade)}:d=${fade}`] : []), 'apad'].join(',');
    args.push('-t', String(segment.duration), '-filter_complex', filter, '-map', '[video]',
      '-map', asset.audio ? '0:a:0' : '1:a:0', '-af', audioFilter,
      '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
      '-map_metadata', '-1', '-movflags', '+faststart', path.join(partsDir, filename));
    await run(config.ffmpeg, args, { signal });
  }
  await fs.writeFile(path.join(partsDir, 'concat.txt'), filenames.map(name => `file '${name}'`).join('\n'));
  if (profile.render.showHook) await fs.writeFile(path.join(partsDir, 'hook.ass'), hookSubtitle(reel.hook, width, height, reel.duration));
  const filename = `reel-${index}.mp4`;
  await report(`Reel ${index}: ${profile.render.showHook ? 'Text und ' : ''}Export mit ${music ? 'eigener Musik und Quellton' : 'Quellton'} werden erstellt.`);
  const finalArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-f', 'concat', '-safe', '1', '-i', 'concat.txt'];
  if (music) finalArgs.push('-i', music.path);
  finalArgs.push('-vf', ['setpts=PTS-STARTPTS', `fps=${config.fps}`, ...(profile.render.showHook ? ['subtitles=hook.ass'] : [])].join(','));
  const sourceFilter = `asetpts=PTS-STARTPTS,${profile.render.normalizeAudio && sourceHasAudio ? 'loudnorm=I=-16:TP=-1.5:LRA=11' : 'aresample=48000'}`;
  if (music) {
    const musicEnd = Math.min(music.duration, reel.duration), fade = Math.min(1, musicEnd / 3);
    finalArgs.push('-filter_complex', `[0:a]${sourceFilter}[original];[1:a]atrim=duration=${reel.duration},asetpts=PTS-STARTPTS,volume=${profile.render.musicGainDb ?? -24}dB,afade=t=in:d=${fade},afade=t=out:st=${musicEnd - fade}:d=${fade},apad[music];[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.84:level=false[mix]`, '-map', '0:v:0', '-map', '[mix]');
  } else finalArgs.push('-map', '0:v:0', '-map', '0:a:0', '-af', `${sourceFilter}${profile.render.normalizeAudio ? '' : ',alimiter=limit=0.84:level=false'}`);
  finalArgs.push('-t', String(reel.duration),
    '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(config.fps), '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1',
    '-movflags', '+faststart', path.join(directory, filename));
  await run(config.ffmpeg, finalArgs, { cwd: partsDir, signal });
  const verified = await probe(path.join(directory, filename), config, signal);
  if (verified.width !== width || verified.height !== height || Math.abs(verified.duration - reel.duration) > 0.65) {
    throw new Error('Der Export hat eine unerwartete Auflösung oder Länge.');
  }
  if (verified.videoCodec !== 'h264' || !verified.audio || verified.audioInfo?.codec !== 'aac' || Math.abs(verified.fps - config.fps) > 0.02) {
    throw new Error('Der Export hat einen unerwarteten Codec, eine fehlende Tonspur oder eine falsche Bildrate.');
  }
  if (Math.abs(verified.videoStartTime) > 0.001 || verified.frameCount !== null && Math.abs(verified.frameCount - Math.ceil(reel.duration * config.fps)) > 1) {
    throw new Error('Der Export beginnt mit versetzter Videospur oder enthält eine unerwartete Bildanzahl.');
  }
  await report(`Reel ${index}: Vollständiger Decode, Bild- und Tonsignale werden geprüft.`);
  const signals = await inspectSignals(path.join(directory, filename), verified, config, signal);
  const review = await createReviewSheets(path.join(directory, filename), verified.duration, directory, index, config, signal);
  const timeline = `timeline-${index}.json`, quality = `quality-${index}.json`;
  await fs.writeFile(path.join(directory, timeline), JSON.stringify(timelineFor(reel, assets, options, profile, music), null, 2));
  const warnings = [
    ...(signals.diagnosticCoverage !== 'complete-log' ? ['Das Diagnoseprotokoll wurde begrenzt; die gespeicherten Signalhinweise sind unvollständig.'] : []),
    ...(verified.audio && (signals.integratedLufs === null || signals.truePeakDbfs === null) ? ['Die Lautheits- oder Spitzenmessung ist unbekannt; keine Hörabnahme daraus ableiten.'] : []),
    ...(signals.black.length ? ['Sehr dunkle Bildbereiche mit Zeitpositionen prüfen; Nachtbilder sind nicht automatisch unbrauchbar.'] : []),
    ...(signals.freeze.length ? ['Lange nahezu unveränderte Bilder mit Zeitpositionen prüfen.'] : []),
    ...(signals.silence.length ? ['Sehr leise Tonbereiche mit Zeitpositionen prüfen.'] : []),
    ...(signals.truePeakDbfs !== null && signals.truePeakDbfs > -0.1 ? ['Tonspitzen liegen nahe 0 dBFS; Pegel prüfen.'] : []),
  ];
  const qa = { technical: 'passed', aesthetic: 'pending-review', warnings };
  await fs.writeFile(path.join(directory, quality), JSON.stringify({ ...qa, checkedAt: new Date().toISOString(), metadata: verified, signals, review,
    scope: 'Vollständiger Decode und technische Signalmessung bestanden. Bildfolgen sind für anschließende redaktionelle Prüfung gespeichert. Kein automatisches ästhetisches Urteil oder subjektiver Hörtest.' }, null, 2));
  const cover = `cover-${index}.jpg`;
  await run(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', '0.1',
    '-i', path.join(directory, filename), '-frames:v', '1', '-q:v', '3', path.join(directory, cover),
  ], { signal, timeout: 30_000 });
  const caption = `caption-${index}.txt`;
  await fs.writeFile(path.join(directory, caption), `${reel.caption}\n`, 'utf8');
  await fs.rm(partsDir, { recursive: true, force: true });
  return { index, filename, cover, caption, title: reel.title, hook: reel.hook,
    hypothesis: reel.hypothesis, captionText: reel.caption, duration: verified.duration, width, height,
    styleProfile: profile.id, timeline, quality, reviewSheets: review.files, qa };
}
