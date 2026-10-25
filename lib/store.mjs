import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export class JobStore {
  constructor(root) { this.root = root; this.jobs = new Map(); }
  directory(id) {
    if (!validId(id)) throw new Error('Ungültige Session-ID.');
    return path.join(this.root, id);
  }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
    for (const name of await fs.readdir(this.root)) {
      if (!validId(name)) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(this.directory(name), 'job.json'), 'utf8'));
        if (job.id !== name || !Array.isArray(job.assets)) continue;
        this.jobs.set(name, job);
        if (['processing', 'uploading'].includes(job.status)) {
          await this.update(name, { status: 'error', stage: 'Unterbrochen',
            error: 'Die Verarbeitung wurde durch einen Neustart unterbrochen. Du kannst die Session erneut starten; ein vorhandener Schnittplan wird wiederverwendet.' });
        }
      } catch { /* Incomplete uploads without job.json are not queued. */ }
    }
  }
  get(id) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async create(job) {
    this.jobs.set(job.id, job);
    await this.save(job);
    return job;
  }
  async update(id, changes) {
    const job = this.get(id);
    if (!job) throw new Error('Session nicht gefunden.');
    Object.assign(job, changes, { updatedAt: new Date().toISOString() });
    await this.save(job);
    return job;
  }
  async save(job) {
    const dir = this.directory(job.id);
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `job-${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
    await fs.rename(temp, path.join(dir, 'job.json'));
  }
  async remove(id) {
    const dir = this.directory(id);
    // id validation fixes the target beneath the configured data directory.
    if (path.dirname(dir) !== path.resolve(this.root)) throw new Error('Ungültiger Speicherpfad.');
    await fs.rm(dir, { recursive: true, force: true });
    this.jobs.delete(id);
  }
  public(job) {
    const {requestHash, ...visible}=job;
    return { ...visible, assets: job.assets.map(({ path: privatePath, ...asset }) => asset),
      outputs: (job.outputs || []).map(output => ({ ...output,
        videoUrl: `/api/jobs/${job.id}/files/${output.filename}`,
        coverUrl: `/api/jobs/${job.id}/files/${output.cover}`,
        captionUrl: `/api/jobs/${job.id}/files/${output.caption}`,
      })) };
  }
}
