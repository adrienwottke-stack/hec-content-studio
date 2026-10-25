import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { validId } from './store.mjs';
import { run } from './process.mjs';

export const maxMusicBytes = 40 * 1024 ** 2;
export function normalizeMusicId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!validId(value)) throw Object.assign(new Error('Ungültige Musikdatei-Referenz.'), { status: 400 });
  return value;
}
const musicDirectory = (config, id) => path.join(config.dataDir, 'music', normalizeMusicId(id) || 'invalid');

export async function resolveMusic(config, id) {
  if (!id) return null;
  const directory = musicDirectory(config, id);
  let record;
  try {
    record = JSON.parse(await fs.readFile(path.join(directory, 'music.json'), 'utf8'));
    await fs.access(path.join(directory, 'original.audio'));
  } catch { throw new Error('Die gewählte Musikdatei fehlt. Eigene Audiodatei erneut auswählen.'); }
  if (record.id !== id || !Number.isFinite(record.duration) || record.duration < 0.5) throw new Error('Die Musikdatei ist nicht lesbar.');
  return { ...record, path: path.join(directory, 'original.audio') };
}

// This route receives only an explicitly supplied file. It neither searches for music
// nor asserts a licence. A stable upload ID is reused after a lost response.
export function attachMusicApi(app, config) {
  const locks = new Map();
  app.put('/api/music/:musicId', async (req, res) => {
    let temporary;
    try {
      const id = normalizeMusicId(req.params.musicId);
      if (!id) throw new Error('Eine Musikdatei-Referenz ist erforderlich.');
      if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('Musik als einzelne Audiodatei übertragen.');
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxMusicBytes) { req.resume(); return res.status(413).json({ error: 'Die Musikdatei darf höchstens 40 MB groß sein.' }); }
      let name;
      try { name = path.basename(decodeURIComponent(req.headers['x-music-name'] || 'Eigene Musik')); } catch { throw new Error('Ungültiger Musikdateiname.'); }
      name = name.replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'Eigene Musik';
      const directory = musicDirectory(config, id);
      await fs.mkdir(directory, { recursive: true });
      temporary = path.join(directory, `${randomUUID()}.upload`);
      let size = 0;
      const hash = createHash('sha256');
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxMusicBytes) return callback(new Error('Die Musikdatei darf höchstens 40 MB groß sein.'));
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(req, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (!size) throw new Error('Die Musikdatei ist leer.');
      const sha256 = hash.digest('hex');
      const previous = locks.get(id) || Promise.resolve();
      const upload = previous.catch(() => {}).then(async () => {
        let known;
        try { known = JSON.parse(await fs.readFile(path.join(directory, 'music.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (known) {
          if (known.sha256 !== sha256) throw Object.assign(new Error('Diese Upload-Referenz gehört zu einer anderen Musikdatei.'), { status: 409 });
          return known;
        }
        const result = await run(config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', temporary], { timeout: 30_000 });
        const probe = JSON.parse(result.stdout);
        const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
        const duration = Number(probe.format?.duration ?? audio?.duration);
        if (!audio || probe.streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic) ||
            !Number.isFinite(duration) || duration < 0.5 || duration > 3600) throw new Error('Eine lesbare Audiodatei von 0,5 Sekunden bis 60 Minuten auswählen.');
        const record = { id, name, size, sha256, duration, channels: Number(audio.channels) || null,
          sampleRate: Number(audio.sample_rate) || null, suppliedAt: new Date().toISOString(), rights: 'user-supplied-unverified' };
        await fs.rename(temporary, path.join(directory, 'original.audio'));
        temporary = null;
        const recordTemp = path.join(directory, `${randomUUID()}.tmp`);
        await fs.writeFile(recordTemp, JSON.stringify(record, null, 2), { mode: 0o600 });
        await fs.rename(recordTemp, path.join(directory, 'music.json'));
        return record;
      });
      locks.set(id, upload);
      try { res.json(await upload); } finally { if (locks.get(id) === upload) locks.delete(id); }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(error.status || 400).json({ error: /ffprobe|spawn|JSON/i.test(error.message) ? 'Die Musikdatei konnte nicht gelesen werden.' : error.message.slice(0, 400) });
    } finally { if (temporary) await fs.rm(temporary, { force: true }); }
  });
}
