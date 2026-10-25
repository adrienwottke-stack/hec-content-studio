import path from 'node:path';

export function configuration(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} muss zwischen ${min} und ${max} liegen.`);
    }
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const password = env.STUDIO_PASSWORD ?? '';
  if (production && password.length < 16) {
    throw new Error('Im Serverbetrieb ist STUDIO_PASSWORD mit mindestens 16 Zeichen erforderlich.');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (!production && !password && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Ohne Passwort darf der Dienst nur auf localhost laufen.');
  }
  return {
    production, host, password,
    username: env.STUDIO_USER || 'hec',
    port: integer('PORT', 4320, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    publicUrl: env.STUDIO_PUBLIC_URL || 'https://reels.127.0.0.1.sslip.io',
    apiKey: env.GEMINI_API_KEY || '',
    analysisProvider: env.ANALYSIS_PROVIDER === 'codex' ? 'codex' : 'gemini',
    asrPython: env.ASR_PYTHON || 'python3',
    asrModelDir: env.ASR_MODEL_DIR || '/opt/asr-models/vosk-model-small-de-0.15',
    model: env.GEMINI_MODEL || 'gemini-3.8-flash',
    providerBase: 'https://generativelanguage.googleapis.com',
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    maxFileBytes: integer('MAX_FILE_MB', 32768, 1, 1048576) * 1024 ** 2,
    maxSessionBytes: integer('MAX_SESSION_MB', 2048, 1, 16384) * 1024 ** 2,
    maxFiles: integer('MAX_FILES', 30, 1, 100),
    maxStorageBytes: integer('MAX_STORAGE_MB', 0, 0, 104857600) * 1024 ** 2,
    storageReserveBytes: integer('STORAGE_RESERVE_MB', 3072, 16, 1048576) * 1024 ** 2,
    uploadChunkBytes: integer('UPLOAD_CHUNK_MB', 16, 1, 64) * 1024 ** 2,
    maxSourceSeconds: integer('MAX_SOURCE_SECONDS', 600, 5, 1800),
    maxSessionSeconds: integer('MAX_SESSION_SECONDS', 1200, 5, 3600),
    width: integer('RENDER_WIDTH', 1080, 360, 1080),
    fps: integer('RENDER_FPS', 30, 24, 60),
  };
}
