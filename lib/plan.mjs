import { features, text as contentText } from './content-validation.mjs';
import { getStyleProfile } from './style-profiles.mjs';

const cropSchema = {
  type: 'object', properties: {
    mode: { type: 'string', enum: ['preserve', 'fill'] },
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', maxLength: 450 },
  }, required: ['mode', 'x', 'y', 'reason'], additionalProperties: false,
};
const audioSchema = {
  type: 'object', properties: {
    mode: { type: 'string', enum: ['original', 'mute'] },
    gainDb: { type: 'number', minimum: -24, maximum: 6 },
    reason: { type: 'string', maxLength: 450 },
  }, required: ['mode', 'gainDb', 'reason'], additionalProperties: false,
};
const evidenceSchema = {
  type: 'object', properties: {
    visualTimes: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'number', minimum: 0 } },
    motion: { type: 'string', maxLength: 450 },
    light: { type: 'string', maxLength: 450 },
    stability: { type: 'string', maxLength: 450 },
    sound: { type: 'string', maxLength: 450 },
    audioBasis: { type: 'string', enum: ['not-listened', 'listened'] },
    limitations: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 450 } },
  }, required: ['visualTimes', 'motion', 'light', 'stability', 'sound', 'audioBasis', 'limitations'], additionalProperties: false,
};

export const planSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    reels: {
      type: 'array', items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, hook: { type: 'string' }, caption: { type: 'string' },
          hypothesis: { type: 'string' },
          segments: {
            type: 'array', items: {
              type: 'object', properties: {
                assetId: { type: 'string' }, from: { type: 'number' }, duration: { type: 'number' },
                reason: { type: 'string' },
                crop: cropSchema, audio: audioSchema, evidence: evidenceSchema,
              }, required: ['assetId', 'from', 'duration', 'reason'],
              additionalProperties: false,
            },
          },
        }, required: ['title', 'hook', 'caption', 'hypothesis', 'segments'],
        additionalProperties: false,
      },
    },
  }, required: ['summary', 'reels'], additionalProperties: false,
};

function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Der Schnittplan enthält einen ungültigen Wert für ${label}.`);
  }
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => value[key] === undefined)) {
    throw new Error(`${label} ist ungültig oder unvollständig.`);
  }
  return value;
}
function number(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} liegt außerhalb des erlaubten Bereichs.`);
  }
  return value;
}
function choice(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label} ist ungültig.`);
  return value;
}
const roundTime = value => Math.round(value * 1000) / 1000;

function validateCrop(raw) {
  object(raw, ['mode', 'x', 'y', 'reason'], 'Bildausschnitt');
  return {
    mode: choice(raw.mode, ['preserve', 'fill'], 'Ausschnittmodus'),
    x: number(raw.x, 0, 1, 'Horizontale Ausschnittposition'),
    y: number(raw.y, 0, 1, 'Vertikale Ausschnittposition'),
    reason: text(raw.reason, 450, 'Ausschnittbegründung'),
  };
}
function validateAudio(raw) {
  object(raw, ['mode', 'gainDb', 'reason'], 'Audioentscheidung');
  return {
    mode: choice(raw.mode, ['original', 'mute'], 'Audiomodus'),
    gainDb: number(raw.gainDb, -24, 6, 'Originaltonverstärkung'),
    reason: text(raw.reason, 450, 'Audiobegründung'),
  };
}
function validateEvidence(raw, asset, segment, requireMotionEvidence) {
  object(raw, ['visualTimes', 'motion', 'light', 'stability', 'sound', 'audioBasis', 'limitations'], 'Szenenbelege');
  const minimum = requireMotionEvidence ? 2 : 1;
  if (!Array.isArray(raw.visualTimes) || raw.visualTimes.length < minimum || raw.visualTimes.length > 64) {
    throw new Error(`Szenenbelege benötigen ${minimum === 2 ? 'mindestens zwei' : 'mindestens eine'} Bildmarken innerhalb der Szene.`);
  }
  const out = Math.min(asset.duration, segment.from + segment.duration);
  const visualTimes = raw.visualTimes.map(at => roundTime(number(at, segment.from, out, 'Bildmarke im Szenenbeleg')));
  if (new Set(visualTimes).size !== visualTimes.length) throw new Error('Die Bildmarken im Szenenbeleg müssen unterschiedlich sein.');
  if (!Array.isArray(raw.limitations) || raw.limitations.length > 8) throw new Error('Höchstens acht Einschränkungen pro Szene angeben.');
  return {
    visualTimes,
    motion: text(raw.motion, 450, 'Bewegungsbeobachtung'),
    light: text(raw.light, 450, 'Lichtbeobachtung'),
    stability: text(raw.stability, 450, 'Stabilitätsbeobachtung'),
    sound: text(raw.sound, 450, 'Tonbeobachtung'),
    audioBasis: choice(raw.audioBasis, ['not-listened', 'listened'], 'Grundlage der Tonbeobachtung'),
    limitations: raw.limitations.map(item => text(item, 450, 'Einschränkung')),
  };
}

// Provider output is data only. No paths, commands, URLs or filters from AI are executed.
export function validatePlan(raw, assets, requestedCount = 1, options = {}) {
  const profile = getStyleProfile(options.styleProfile);
  const materialDriven = profile.id === 'late-night-drive';
  if (!raw || !Array.isArray(raw.reels) || raw.reels.length < 1 || raw.reels.length > requestedCount) {
    throw new Error('Der Schnittplan enthält keine passende Anzahl Reels.');
  }
  const sourceMap = new Map(assets.map(asset => [asset.id, asset]));
  return {
    summary: text(raw.summary, 1600, 'Zusammenfassung'),
    reels: raw.reels.map(reel => {
      if (!Array.isArray(reel.segments) || !reel.segments.length || reel.segments.length > 24) {
        throw new Error('Der Schnittplan enthält eine ungültige Szenenanzahl.');
      }
      const segments = reel.segments.map(segment => {
        const asset = sourceMap.get(segment.assetId);
        if (!asset) throw new Error('Der Schnittplan verweist auf eine unbekannte Aufnahme.');
        const { from, duration } = segment;
        if (typeof from !== 'number' || typeof duration !== 'number' || !Number.isFinite(from) ||
            !Number.isFinite(duration) || from < 0 || duration < 0.5 || duration > 15 ||
            from + duration > asset.duration + 0.08) {
          throw new Error('Eine Schnittmarke liegt außerhalb der Aufnahme oder ist zu lang.');
        }
        if (materialDriven && (!segment.crop || !segment.audio || !segment.evidence)) {
          throw new Error('Late Night Drive benötigt pro Szene einen Bildausschnitt, eine Audioentscheidung und Szenenbelege.');
        }
        const decisions = {};
        if (segment.crop !== undefined) decisions.crop = validateCrop(segment.crop);
        if (segment.audio !== undefined) decisions.audio = validateAudio(segment.audio);
        if (segment.evidence !== undefined) decisions.evidence = validateEvidence(segment.evidence, asset, segment, materialDriven);
        return {
          assetId: asset.id, from: roundTime(from),
          duration: roundTime(Math.min(duration, asset.duration - from)),
          reason: text(segment.reason, 450, 'Szenenbegründung'),
          ...decisions,
        };
      });
      if (materialDriven) {
        const selected = new Map();
        for (const segment of segments) {
          const source = sourceMap.get(segment.assetId);
          const sourceKey = source.sha256 || source.libraryId || source.id;
          const previous = selected.get(sourceKey) || [];
          if (previous.some(other => segment.from < other.from + other.duration && other.from < segment.from + segment.duration)) {
            throw new Error('Late Night Drive darf keine identischen oder überlappenden Zeitfenster derselben Quelle wiederholen.');
          }
          previous.push(segment); selected.set(sourceKey, previous);
        }
      }
      const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
      if (duration < 1 || duration > 60) throw new Error('Ein Reel muss zwischen 1 und 60 Sekunden lang sein.');
      const editorial = reel.features ? { features: features(reel.features, Math.round(duration * 1000) / 1000) } : {};
      if (reel.briefingApplied !== undefined) {
        if (!Array.isArray(reel.briefingApplied) || reel.briefingApplied.length > 8) throw new Error('Briefinganwendung ist ungültig.');
        editorial.briefingApplied = reel.briefingApplied.map(item => ({ sourceId: contentText(item.sourceId, 100, 'Briefingquelle', true), change: contentText(item.change, 500, 'Briefinganwendung', true) }));
      }
      return {
        title: text(reel.title, 100, 'Titel'), hook: profile.render.showHook === false
          ? contentText(reel.hook, 130, 'Einstieg') : text(reel.hook, 130, 'Einstieg'),
        caption: text(reel.caption, 2200, 'Caption'),
        hypothesis: text(reel.hypothesis, 700, 'Testidee'),
        segments, duration: Math.round(duration * 1000) / 1000, ...editorial,
      };
    }),
  };
}

export function quickPlan(assets, requestedDuration) {
  let remaining = requestedDuration;
  const segments = [];
  for (const asset of assets) {
    if (remaining < 0.5) break;
    const duration = Math.min(asset.duration, 4, remaining);
    if (duration >= 0.5) {
      segments.push({ assetId: asset.id, from: 0, duration, reason: 'Anfang der Aufnahme; keine KI-Auswahl.' });
      remaining -= duration;
    }
  }
  return validatePlan({
    summary: 'Technischer Probeschnitt. Die Aufnahmen werden in Upload-Reihenfolge zusammengesetzt; es fand keine KI-Szenenanalyse statt.',
    reels: [{
      title: 'Probeschnitt', hook: 'Technischer Probeschnitt',
      caption: 'Technischer Probeschnitt aus den hochgeladenen Aufnahmen. Ohne KI-Szenenauswahl.',
      hypothesis: 'Dieser Probeschnitt prüft Upload, Hochformat und Export. Er bewertet keine Zuschauerwirkung.', segments,
    }],
  }, assets, 1);
}
