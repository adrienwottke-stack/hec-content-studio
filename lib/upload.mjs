import busboy from 'busboy';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function receiveVideos(req, directory, config, storageUsed) {
  await fs.mkdir(directory, { recursive: true });
  const fields = {}, assets = [], writes = [];
  let failure, bytes = 0;
  const parser = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: {
    files: config.maxFiles, fileSize: config.maxFileBytes, fields: 12, fieldSize: 8000, parts: config.maxFiles + 12,
  } });
  parser.on('field', (name, value, info) => {
    if (info.valueTruncated) failure = new Error('Ein Textfeld ist zu lang.');
    if (['title', 'brief', 'mode', 'count', 'duration', 'fit', 'goal', 'collection', 'recordedAt'].includes(name)) fields[name] = value;
  });
  parser.on('filesLimit', () => { failure = new Error(`Maximal ${config.maxFiles} Aufnahmen pro Upload.`); });
  parser.on('fieldsLimit', () => { failure = new Error('Zu viele Textfelder.'); });
  parser.on('partsLimit', () => { failure = new Error('Zu viele Upload-Teile.'); });
  parser.on('file', (field, stream, info) => {
    const name = info.filename.replace(/\\/g, '/').split('/').pop().replace(/[\u0000-\u001f]/g, '').slice(0, 180);
    const extension = path.extname(name).toLowerCase();
    if (field !== 'videos' || !['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'].includes(extension)) {
      failure = new Error('Bitte Videoaufnahmen als MP4, MOV, M4V, MKV, WEBM oder AVI hochladen.'); stream.resume(); return;
    }
    const asset = { id: randomUUID(), name, path: '', size: 0 };
    asset.path = path.join(directory, `${asset.id}${extension}`);
    const hash = createHash('sha256'); assets.push(asset);
    stream.on('limit', () => { failure = new Error(`Eine Aufnahme überschreitet ${config.maxFileBytes / 1024 ** 2} MB.`); });
    const counter = new Transform({ transform(chunk, encoding, callback) {
      asset.size += chunk.length; bytes += chunk.length; hash.update(chunk);
      if (bytes > config.maxSessionBytes || storageUsed + bytes > config.maxStorageBytes) {
        failure = new Error('Der Upload oder der verfügbare Footage-Speicher ist ausgelastet. Bitte weniger Aufnahmen hochladen.');
      }
      callback(null, failure ? undefined : chunk);
    } });
    writes.push(pipeline(stream, counter, createWriteStream(asset.path, { flags: 'wx', mode: 0o600 }))
      .then(() => { asset.sha256 = hash.digest('hex'); }).catch(error => { failure ||= error; }));
  });
  try {
    await new Promise((resolve, reject) => {
      const aborted = () => { parser.destroy(new Error('Upload unterbrochen.')); };
      req.once('aborted', aborted);
      parser.once('error', reject);
      parser.once('close', () => { req.off('aborted', aborted); resolve(); });
      req.pipe(parser);
    });
    await Promise.all(writes);
    if (failure) throw failure;
    if (!assets.length) throw new Error('Bitte mindestens eine Videoaufnahme hochladen.');
    return { fields, assets };
  } catch (error) { await Promise.allSettled(writes); throw error; }
}
