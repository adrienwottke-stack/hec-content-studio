// Preview generation, provider analysis and rendering share the small server's worker.
export class SerialMedia {
  constructor() { this.pending = []; this.busy = false; }
  run(task, signal) {
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject };
      const abort = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) { this.pending.splice(index, 1); reject(signal.reason); }
      };
      entry.abort = abort;
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push(entry);
      this.drain();
    });
  }
  async drain() {
    if (this.busy || !this.pending.length) return;
    this.busy = true;
    const entry = this.pending.shift();
    entry.signal?.removeEventListener('abort', entry.abort);
    try { entry.signal?.throwIfAborted(); entry.resolve(await entry.task()); }
    catch (error) { entry.reject(error); }
    finally { this.busy = false; this.drain(); }
  }
}
