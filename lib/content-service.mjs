import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { linkOriginal } from './library.mjs';
import { ContentStore } from './content-store.mjs';
import { fail } from './content-validation.mjs';
import { knowledgeNotes } from './content-knowledge.mjs';

async function fileDigest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

export class ContentService {
  constructor(config, library, jobs, queue, brain, dependencies = {}) {
    this.config = config; this.library = library; this.jobs = jobs; this.queue = queue; this.brain = brain;
    this.content = new ContentStore(config.dataDir, dependencies); this.dispatchLock = Promise.resolve(); this.observed = new Map(); this.closing = false;
  }
  async initialize() {
    await this.content.initialize();
    for (const job of this.jobs.list()) {
      if (!this.content.versionForJob(job.id)) await this.content.registerJob({ ...job, legacy: true });
      await this.observe(job);
    }
  }
  async attach(job) {
    const versions = await this.content.registerJob(job);
    const active = versions[0];
    if (active.requiresBriefing && !job.options.productionBrief) await this.jobs.update(job.id, { options: { ...job.options,
      accountId: active.accountId, isTest: active.isTest, productionBrief: { versionId: active.id, ...active.briefing } } });
    await this.observe(job); return versions;
  }
  async observe(job) {
    if (!job || !this.content.versionForJob(job.id)) return;
    const signature = JSON.stringify([job.status, job.updatedAt, job.outputs?.length]);
    if (this.observed.get(job.id) === signature) return;
    if (!this.content.versionForJob(job.id).plan) {
      try { const plan = JSON.parse(await fs.readFile(path.join(this.jobs.directory(job.id), 'outputs', 'plan.json'), 'utf8')); await this.content.planReceived(job.id, plan); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let exports = null;
    if (job.status === 'done') {
      exports = [];
      for (const output of job.outputs || []) {
        const directory = path.join(this.jobs.directory(job.id), 'outputs');
        exports.push({ ...output, videoSha256: await fileDigest(path.join(directory, output.filename)), coverSha256: await fileDigest(path.join(directory, output.cover)),
          captionSha256: await fileDigest(path.join(directory, output.caption)), bytes: (await fs.stat(path.join(directory, output.filename))).size,
          confirmedAt: new Date().toISOString(), videoUrl: `/api/jobs/${job.id}/files/${output.filename}`, coverUrl: `/api/jobs/${job.id}/files/${output.cover}`,
          captionUrl: `/api/jobs/${job.id}/files/${output.caption}`, planUrl: `/api/jobs/${job.id}/files/plan.json` });
      }
    }
    await this.content.jobObserved(job, exports); this.observed.set(job.id, signature);
  }
  dispatch() {
    const next = this.dispatchLock.catch(() => {}).then(async () => {
      if (this.closing) return [];
      const pending = this.content.state.versions.filter(version => version.renderStatus === 'reserved').sort((a, b) => Number(Boolean(b.parentVersionId)) - Number(Boolean(a.parentVersionId)) || a.createdAt.localeCompare(b.createdAt));
      const created = [];
      for (const version of pending) {
        const existing = this.jobs.get(version.jobId);
        if (existing) { await this.observe(existing); if (existing.status === 'queued') this.queue.enqueue(existing.id); continue; }
        if (this.jobs.list().filter(job => ['queued', 'processing', 'waiting-brain'].includes(job.status)).length >= 5) break;
        const concept = this.content.state.concepts.find(item => item.id === version.conceptId);
        try {
          const clips = version.assetIds.map(id => {
            const clip = this.library.get(id);
            if (!clip || clip.archived || clip.status !== 'ready' || clip.duration > this.config.maxSourceSeconds) throw fail('Eine vorgesehene Originalaufnahme ist nicht mehr verfügbar oder zu lang.', 409);
            return clip;
          });
          if (clips.reduce((sum, clip) => sum + clip.duration, 0) > this.config.maxSessionSeconds) throw fail('Die ausgewählten Quellen überschreiten die Sessionlänge. Kleinere Auswahl verwenden.');
          const directory = path.join(this.jobs.directory(version.jobId), 'inputs'); await fs.mkdir(directory, { recursive: true });
          const assets = [];
          for (const clip of clips) {
            const destination = path.join(directory, `${clip.id}${clip.extension}`);
            try { await linkOriginal(clip.path, destination); } catch (error) {
              if(error.code!=='EEXIST')throw error;
              const originalStat=await fs.stat(clip.path),storedStat=await fs.stat(destination);
              if(!(originalStat.ino===storedStat.ino&&originalStat.dev===storedStat.dev)&&await fileDigest(destination)!==clip.sha256)throw fail('Eine unbestätigte Auftragsquelle stimmt nicht mit dem Bibliotheksoriginal überein.',409);
            }
            const indexed = this.library.public(clip);
            assets.push({ id: clip.id, libraryId: clip.id, name: clip.name, sha256: clip.sha256, path: destination, size: clip.size, duration: clip.duration, width: clip.width, height: clip.height, audio: clip.audio,
              context: clip.context, note: clip.note, collections: clip.collections, catalog: { title: indexed.title, category: indexed.category, tags: indexed.tags, description: indexed.description, moments: indexed.moments, basis: indexed.classificationSource } });
          }
          const job = await this.jobs.create({ id: version.jobId, title: concept.title, createdAt: version.createdAt, updatedAt: new Date().toISOString(), assets, outputs: [],
            options: { ...version.options, accountId: version.accountId, isTest: version.isTest, collection: concept.collection, productionBrief: { versionId: version.id, ...version.briefing } },
            status: 'queued', stage: version.parentVersionId ? 'Feedback-Revision reserviert · wartet auf Schnittplanung.' : 'Reel-Vorschlag reserviert · wartet auf Schnittplanung.', progress: 0 });
          await this.observe(job); this.queue.enqueue(job.id); created.push(version.id);
        } catch (error) {
          await this.content.transaction(state => { const current = state.versions.find(item => item.id === version.id); current.renderStatus = 'error'; current.error = error.status ? error.message : 'Der reservierte Auftrag konnte nicht bereitgestellt werden.'; return { ok: true }; });
          console.error('Content-Auftrag konnte nicht bereitgestellt werden:', version.id);
        }
      }
      return created;
    }); this.dispatchLock = next; return next;
  }
  async tick({ learning = true, autopilot = true, test = false } = {}) {
    for (const job of this.jobs.list()) await this.observe(job);
    const runs = [];
    if (learning) for (const account of this.content.state.accounts) {
      const run = await this.content.prepareLearning({ accountId: account.id, isTest: test });
      if (run && ['queued', 'waiting-codex'].includes(run.status)) { await this.brain.prepareLearning(run); runs.push(run.id); }
    }
    // Fresh feedback must be prepared before reserving a version's production brief.
    const reserved = autopilot ? await this.content.reserveAutopilot(this.library.list(), { isTest: test }) : [];
    await this.dispatch();
    return { ok: true, reservedVersionIds: reserved.map(item => item.id), learningRunIds: runs };
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(error => console.error('Content-Auswertung:', error.status ? error.message : 'Lokaler Lauf fehlgeschlagen.')), 60000); this.timer.unref();
  }
  async close() { this.closing = true; clearInterval(this.timer); await this.dispatchLock.catch(() => {}); }
  async retry(versionId) {
    const version=this.content.version(versionId),job=this.jobs.get(version.jobId);
    if(!['error','cancelled'].includes(version.renderStatus))throw fail('Diese Version benötigt gerade keinen technischen Retry.',409);
    if(job) {
      if(!['error','cancelled'].includes(job.status))throw fail('Der bestehende Auftrag wird bereits bearbeitet.',409);
      await this.jobs.update(job.id,{status:'queued',stage:'Technischer Retry · vorhandener Plan bleibt erhalten.',error:null,progress:0});
      this.queue.enqueue(job.id);await this.observe(job);
    } else {
      await this.content.transaction(state=>{const current=state.versions.find(item=>item.id===version.id);current.renderStatus='reserved';current.error=null;return {ok:true};});
      await this.dispatch();
    }
    return this.content.version(versionId);
  }
  async snapshot(options) { for (const job of this.jobs.list()) await this.observe(job); return this.content.snapshot(options); }
  knowledge(options) { return knowledgeNotes(this.content.state, options); }
  protectedJob(jobId) {
    const versions = this.content.state.versions.filter(item => item.jobId === jobId);
    return versions.some(version => this.content.state.reviews.some(item => item.versionId === version.id) || this.content.state.publications.some(item => item.relatedVersionId === version.id) ||
      this.content.state.versions.some(item => item.parentVersionId === version.id));
  }
}
