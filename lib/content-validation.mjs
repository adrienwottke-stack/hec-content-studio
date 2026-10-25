import { createHash } from 'node:crypto';
import { validId } from './store.mjs';

export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function text(value, max, label, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${label}: bitte einen passenden Text eingeben.`);
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}
export function id(value, label = 'Referenz') { if (!validId(value)) throw fail(`${label} ist ungültig.`); return value; }
export function choice(value, allowed, label, fallback) {
  const result = value === undefined || value === '' ? fallback : value;
  if (!allowed.includes(result)) throw fail(`${label} ist ungültig.`);
  return result;
}
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`${label} muss zwischen ${min} und ${max} liegen.`);
  return value;
}
export function timestamp(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail(`${label}: ISO-Zeit mit Zeitzone erforderlich, z.B. 2026-10-04T18:00:00+02:00.`);
  const date = value.slice(0, 10), check = new Date(`${date}T12:00:00Z`);
  if (check.toISOString().slice(0, 10) !== date) throw fail(`${label}: Datum existiert nicht.`);
  return new Date(value).toISOString();
}
export function handle(value) {
  const result = text(value, 31, 'Kontoname', true).replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.]{1,30}$/.test(result)) throw fail('Instagram-Kontoname ist ungültig.');
  return result;
}
export function reelLink(value) {
  let url; try { url = new URL(value); } catch { throw fail('Bitte einen vollständigen Instagram-Reel-Link angeben.'); }
  if (url.protocol !== 'https:' || !['www.instagram.com', 'instagram.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/(reel|p|tv)\/[A-Za-z0-9_-]{3,80}\/?$/.test(url.pathname)) throw fail('Bitte einen Instagram-Beitragslink mit /reel/, /p/ oder /tv/ angeben.');
  return `https://www.instagram.com${url.pathname.replace(/\/$/, '')}/`;
}
export function evidenceIds(value = []) {
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length) throw fail('Höchstens acht unterschiedliche Belege verwenden.');
  return value.map(item => id(item, 'Beleg'));
}
export const metricDefinitions = {
  views: ['Aufrufe', 'count'], reach: ['Reichweite', 'accounts'], likes: ['Likes', 'count'], comments: ['Kommentare', 'count'],
  shares: ['Teilungen', 'count'], saves: ['Speicherungen', 'count'], avg_watch_time_seconds: ['Ø Wiedergabezeit', 'seconds'],
  total_watch_time_seconds: ['Gesamte Wiedergabezeit', 'seconds'], follows: ['Zugerechnete Follows', 'count'], qualified_inquiries: ['Qualifizierte Kontakte', 'count'],
};
export function metrics(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('Kennzahlen sind ungültig.');
  const result = {};
  for (const [key, [label]] of Object.entries(metricDefinitions)) {
    const input = raw[key];
    if (input === undefined || input === null || input === '') { result[key] = null; continue; }
    if (typeof input !== 'number' && typeof input !== 'string') throw fail(`${label}: eine nicht negative Zahl oder ein leeres Feld eingeben.`);
    if (typeof input === 'string' && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input)) throw fail(`${label}: ohne Tausendertrennzeichen; Dezimalpunkt verwenden.`);
    const number = Number(input);
    if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER || (!key.endsWith('_seconds') && !Number.isSafeInteger(number))) throw fail(`${label}: ungültige Zahl.`);
    result[key] = number;
  }
  return result;
}
export const featureKeys = ['topic', 'opening', 'action', 'cut', 'sound', 'text', 'expectedReaction'];
export function features(raw, duration) {
  if (!raw || typeof raw !== 'object') throw fail('Beobachtbare Merkmale des Entwurfs fehlen.');
  const result = Object.fromEntries(featureKeys.map(key => [key, text(raw[key], 300, `Merkmal ${key}`, true)]));
  result.lengthSeconds = duration;
  return result;
}
export const csvHeader = 'account_handle;reel_id;reel_version;instagram_media_id;permalink;published_at;measured_at;source;evidence_path;platform_scope;distribution;views;reach;likes;comments;shares;saves;avg_watch_time_seconds;follows;qualified_inquiries;notes';

// Semicolon CSV with quoted multiline fields, escaped quotes and a UTF-8 BOM.
export function parseCsv(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 2 * 1024 ** 2) throw fail('CSV ist zu groß (höchstens 2 MB).');
  input = input.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
  for (let index = 0; index <= input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === undefined) throw fail('CSV: ein Anführungszeichen wurde nicht geschlossen.');
      if (char === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
    } else if (char === '"' && !cell && !afterQuote) quoted = true;
    else if (char === ';' || char === '\n' || char === undefined) {
      row.push(cell.replace(/\r$/, '')); cell = ''; afterQuote = false;
      if (char !== ';') { if (row.some(value => value !== '')) rows.push(row); row = []; }
    } else if (afterQuote && char !== '\r') throw fail('CSV: unerwarteter Text nach einem geschlossenen Feld.');
    else if (char === '"') throw fail('CSV: Text mit Anführungszeichen vollständig quotieren.');
    else if (!afterQuote) cell += char;
    if (rows.length > 1000 || cell.length > 20000) throw fail('CSV: höchstens 1000 Zeilen und begrenzte Feldlängen.');
  }
  if (!rows.length) throw fail('CSV-Kopfzeile fehlt.');
  const columns = rows.shift().map(value => value.trim());
  if (new Set(columns).size !== columns.length || columns.some(value => !/^[a-z_]+$/.test(value))) throw fail('CSV-Spalten sind ungültig oder doppelt.');
  for (const required of ['account_handle', 'permalink', 'published_at', 'measured_at', 'source']) if (!columns.includes(required)) throw fail(`CSV-Spalte ${required} fehlt.`);
  return rows.map((cells, index) => ({ line: index + 2, raw: cells.join(';'), ...(cells.length !== columns.length ? { error: 'Die Zeile hat eine andere Spaltenzahl als die Kopfzeile.' } : { value: Object.fromEntries(columns.map((column, n) => [column, cells[n]])) }) }));
}

export function normalizedMeasurement(raw, now = new Date()) {
  const publishedAt = timestamp(raw.published_at ?? raw.publishedAt, 'Veröffentlicht am');
  const measuredAt = timestamp(raw.measured_at ?? raw.measuredAt, 'Gemessen am');
  if (Date.parse(measuredAt) < Date.parse(publishedAt)) throw fail('Die Messung liegt vor der Veröffentlichung.');
  if (Date.parse(measuredAt) > now.getTime() + 300000) throw fail('Eine tatsächlich erfolgte Messung darf nicht in der Zukunft liegen.');
  const platformScope = choice(raw.platform_scope ?? raw.platformScope, ['instagram', 'facebook', 'crosspost', 'mixed', 'unknown'], 'Plattformumfang', 'unknown');
  const distribution = choice(raw.distribution, ['organic', 'paid', 'mixed', 'unknown'], 'Ausspielung', 'unknown');
  const result = { accountHandle: handle(raw.account_handle ?? raw.accountHandle ?? 'adrien.e39'), permalink: reelLink(raw.permalink), publishedAt, measuredAt,
    source: text(raw.source, 80, 'Messquelle', true), platformScope, distribution, period: choice(raw.period, ['lifetime', 'interval', 'unknown'], 'Zeitraum', 'lifetime'),
    values: metrics(raw.metrics ?? raw), units: Object.fromEntries(Object.entries(metricDefinitions).map(([key, [, unit]]) => [key, unit])),
    ageHours: Math.round((Date.parse(measuredAt) - Date.parse(publishedAt)) / 3600) / 1000,
    evidenceIds: evidenceIds(raw.evidenceIds), evidenceReference: text(raw.evidence_path ?? raw.evidenceReference, 500, 'Belegreferenz'),
    notes: text(raw.notes, 1600, 'Notiz'), correctionOf: raw.correctionOf || raw.correction_of || null,
    instagramMediaId: text(raw.instagram_media_id ?? raw.instagramMediaId, 80, 'Instagram-Media-ID'),
    proposedReelId: raw.reel_id || raw.reelId || null, proposedVersion: raw.reel_version === '' || raw.reel_version === undefined ? raw.reelVersion ?? null : Number(raw.reel_version),
  };
  if (result.correctionOf) id(result.correctionOf, 'Zu korrigierende Messung');
  if (result.proposedReelId) id(result.proposedReelId, 'Reel-ID');
  if (result.proposedVersion !== null) integer(result.proposedVersion, 1, 1000, 'Reel-Version');
  if (!Object.values(result.values).some(value => value !== null)) throw fail('Bitte mindestens eine verfügbare Kennzahl angeben.');
  return result;
}
