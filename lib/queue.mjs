import fs from 'node:fs/promises';
import path from 'node:path';
import { probe, createProxy, renderReel } from './media.mjs';
import { quickPlan, validatePlan } from './plan.mjs';
import { planWithGemini } from './provider.mjs';
import { getStyleProfile } from './style-profiles.mjs';
import { fileHash } from './library.mjs';

export class RenderQueue {
  constructor(store, config, { planner = planWithGemini, serial, brain } = {}) {
    this.store = store; this.config = config; this.planner = planner; this.serial = serial;
    this.brain = brain;
    this.waiting = []; this.running = null; this.controller = null; this.closing = false;
  }
  enqueue(id) {
    if (this.running === id || this.waiting.includes(id) || this.closing) return;
    this.waiting.push(id);
    setImmediate(() => this.drain());
  }
  cancel(id) {
    if (this.running === id) this.controller.abort();
    this.waiting = this.waiting.filter(value => value !== id);
  }
  async drain() {
    if (this.running || this.closing || !this.waiting.length) return;
    const id = this.waiting.shift();
    const job = this.store.get(id);
    if (!job || job.status !== 'queued') return this.drain();
    this.running = id; this.controller = new AbortController();
    try {
      const signal = this.controller.signal;
      if (this.serial) await this.serial.run(() => this.process(job,signal),signal);
      else await this.process(job,signal);
    }
    catch (error) {
      const aborted = this.controller.signal.aborted;
      const resuming = aborted && this.closing;
      // Technical details stay on the server, never in the public response.
      if (!aborted) console.error(`Job ${id}:`, error.message);
      await this.store.update(id, { status: resuming ? 'queued' : aborted ? 'cancelled' : 'error',
        stage: resuming ? 'Gespeichert · wird nach Serverneustart fortgesetzt.' : aborted ? 'Abgebrochen' : 'Verarbeitung fehlgeschlagen',
        error: aborted ? null : publicError(error), progress: 0 });
      await this.onStatus?.(this.store.get(id));
    } finally {
      const dir = this.store.directory(id);
      await fs.rm(path.join(dir, 'proxies'), { recursive: true, force: true });
      this.running = null; this.controller = null;
      if (!this.closing) setImmediate(() => this.drain());
    }
  }
  async process(job, signal) {
    const config = this.config;
    const dir = this.store.directory(job.id);
    const outputDir = path.join(dir, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });
    await this.store.update(job.id, { status: 'processing', stage: 'Aufnahmen werden geprüft.', error: null, progress: 5, outputs: [] });
    const assets = [];
    let sourceDuration = 0;
    for (const source of job.assets) {
      signal.throwIfAborted();
      const info = await probe(source.path, config, signal);
      sourceDuration += info.duration;
      if (info.duration > config.maxSourceSeconds || sourceDuration > config.maxSessionSeconds) {
        throw new Error('Die Session überschreitet die erlaubte Aufnahmelänge. Bitte in kleinere Sessions aufteilen.');
      }
      if (info.width > 8192 || info.height > 8192) throw new Error('Die Auflösung der Aufnahme ist zu groß.');
      assets.push({ ...source, ...info, sha256: source.sha256 || await fileHash(source.path) });
    }
    await this.store.update(job.id, { assets, progress: 12 });
    await fs.writeFile(path.join(outputDir, 'source-inventory.json'), JSON.stringify({
      checkedAt: new Date().toISOString(), styleProfile: getStyleProfile(job.options.styleProfile).id,
      sources: assets.map(({ path: privatePath, ...asset }) => asset),
      notice: 'Technische Quelldaten; Kontext und Dateiname ersetzen keine Bild- oder Tonprüfung.',
    }, null, 2));
    let plan;
    const planPath = path.join(outputDir, 'plan.json');
    try {
      const cached = JSON.parse(await fs.readFile(planPath, 'utf8'));
      plan = { ...cached, ...validatePlan(cached, assets, job.options.mode === 'quick' ? 1 : job.options.count, job.options.mode === 'quick' ? {} : job.options) };
      await this.store.update(job.id, { stage: 'Vorhandener Schnittplan wird wiederverwendet.', progress: 40 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Ein vorhandener Schnittplan ist beschädigt. Bitte eine neue Session anlegen.');
      if (job.options.mode === 'quick') {
        plan = { ...quickPlan(assets, job.options.duration), provider: 'none', mode: 'quick' };
      } else if(config.analysisProvider==='codex'||job.options.mode==='codex') {
        await this.brain.prepareJob(job,assets,signal);
        return;
      } else {
        if (!config.apiKey) throw new Error('Videoanalyse ist noch nicht verbunden. GEMINI_API_KEY auf dem Server hinterlegen.');
        const proxyDir = path.join(dir, 'proxies');
        await fs.mkdir(proxyDir, { recursive: true });
        const proxies = [];
        for (let i = 0; i < assets.length; i++) {
          await this.store.update(job.id, { stage: `Aufnahme ${i + 1} wird für die Analyse vorbereitet.`, progress: 15 + Math.round(i / assets.length * 10) });
          const proxy = path.join(proxyDir, `source-${i}.mp4`);
          await createProxy(assets[i], proxy, config, signal);
          proxies.push(proxy);
        }
        plan = await this.planner(assets, proxies, job.options, config, signal,
          stage => this.store.update(job.id, { stage, progress: 30 }));
      }
      plan = { ...plan, styleBrief: getStyleProfile(job.options.styleProfile) };
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
    }
    await this.store.update(job.id, { summary: plan.summary, progress: 45 });
    const outputs = [];
    for (let i = 0; i < plan.reels.length; i++) {
      const output = await renderReel(plan.reels[i], i + 1, assets, { ...job.options, styleBrief: plan.styleBrief }, config, outputDir, signal,
        stage => this.store.update(job.id, { stage, progress: 45 + Math.round(i / plan.reels.length * 45) }));
      outputs.push(output);
      await this.store.update(job.id, { outputs: [...outputs] });
    }
    await this.store.update(job.id, { status: 'done', stage: 'Fertig zum Anschauen und Herunterladen.',
      progress: 100, outputs, finishedAt: new Date().toISOString(),
      providerCleanupWarning: plan.cleanup?.some(file => !file.deleted) || false });
    await this.onStatus?.(this.store.get(job.id));
  }
  async close() {
    this.closing = true;
    if (this.controller) this.controller.abort();
    const deadline = Date.now() + 20_000;
    while (this.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function publicError(error) {
  if (/ffmpeg|ffprobe|spawn|JSON|Unexpected/i.test(error.message)) {
    return 'Eine Aufnahme oder der Export konnte nicht verarbeitet werden. Format und Datei prüfen und erneut versuchen.';
  }
  return error.message.slice(0, 450);
}
