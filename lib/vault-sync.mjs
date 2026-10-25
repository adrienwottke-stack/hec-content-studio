import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const within = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith('..') && !path.isAbsolute(relative); };
async function atomic(file, content) { const temp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temp, content, { mode: 0o600 }); await fs.rename(temp, file); }
const noteIdPattern = /^[a-z-]+-[a-f0-9-]{36}$/;
const windowsKey = value => value.normalize('NFC').toLowerCase();
function readableBase(note) {
  const heading = /^#\s+(.+)$/m.exec(note.content)?.[1];
  const defaults = { profile: 'Studio Stilprofil', index: 'Studio Lernstrecke', version: 'Studio Schnittversion', publication: 'Studio Veröffentlichung', learning: 'Studio Erkenntnis', reference: 'Studio Referenz' };
  let name = (heading || defaults[note.id.split('-')[0]] || 'Studio Notiz').normalize('NFC')
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '')
    .replace(/\\([\[\]])/g, '$1').replace(/[<>:"/\\|?*\x00-\x1f\[\]#^]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120).replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'Studio Notiz';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `Notiz - ${name}`;
  return name;
}
function safeStoredName(value) {
  return typeof value === 'string' && value.endsWith('.md') && value === path.basename(value)
    && value.length <= 140 && !/[<>:"/\\|?*\x00-\x1f\[\]#^]/.test(value)
    && !/[. ]+$/.test(value.slice(0, -3)) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value);
}
// Publish a new path without replacing a file that appeared since the name was chosen.
async function createExclusive(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, content, { mode: 0o600 });
  try { await fs.link(temp, file); } finally { await fs.unlink(temp); }
}
async function readNote(file) {
  try {
    const info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Verknüpfte oder fremde Notiz wird nicht überschrieben.');
    return await fs.readFile(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const managedBlock = (id, content) => `<!-- HEC-STUDIO:${id}:START -->\n${content.trimEnd()}\n<!-- HEC-STUDIO:${id}:END -->`;
function existingBlock(id, current) {
  if (current === undefined) return null;
  const start = `<!-- HEC-STUDIO:${id}:START -->`, end = `<!-- HEC-STUDIO:${id}:END -->`;
  const from = current.indexOf(start), to = current.indexOf(end);
  return from >= 0 && to > from ? { from, to: to + end.length, text: current.slice(from, to + end.length) } : null;
}
export async function syncVault(payload, { vault, subfolder = 'Projekte/HEC/Content-Lernen', allowFixture = false } = {}) {
  if (!vault || (!allowFixture && subfolder.replace(/\\/g, '/') !== 'Projekte/HEC/Content-Lernen')) throw new Error('Vault-Sync schreibt ausschließlich in Projekte/HEC/Content-Lernen.');
  const vaultRoot = await fs.realpath(path.resolve(vault)), target = path.resolve(vaultRoot, subfolder, payload.test ? 'Studio-Tests' : 'Studio-Sync');
  if (!within(vaultRoot, target)) throw new Error('Vault-Ziel liegt außerhalb des erlaubten Ordners.');
  const relative = path.relative(vaultRoot, target).split(path.sep); let checked = vaultRoot;
  for (const part of relative) { checked = path.join(checked, part); try { if ((await fs.lstat(checked)).isSymbolicLink()) throw new Error('Verknüpfte Vault-Zielordner werden nicht beschrieben.'); } catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(checked); } }
  if ((await fs.realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error('Vault-Ziel wurde umgeleitet.');
  const lockFile = path.join(target, '.hec-sync.lock'); let lock;
  try { lock = await fs.open(lockFile, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // An interrupted local process leaves a lock; never steal one from a live process.
    let old; try { old = JSON.parse(await fs.readFile(lockFile, 'utf8')); } catch { throw new Error('Vault-Sync-Sperre ist unklar; erst den vorhandenen Lauf prüfen.'); }
    let alive = true; try { process.kill(old.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Ein Vault-Sync läuft bereits.');
    await fs.unlink(lockFile); lock = await fs.open(lockFile, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const result = { created: 0, updated: 0, unchanged: 0, renamed: 0, conflicts: [], files: {}, target };
  try {
    const stateFile = path.join(target, '.hec-sync-state.json'); let state = { notes: {} };
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state.notes || typeof state.notes !== 'object' || Array.isArray(state.notes) || !Array.isArray(payload.notes)) throw new Error('Ungültiger Vault-Sync-Zustand.');
    const ids = new Set();
    for (const note of payload.notes) {
      if (!noteIdPattern.test(note.id) || ids.has(note.id) || typeof note.content !== 'string' || note.content.includes('<!-- HEC-STUDIO:')) throw new Error('Ungültige generierte Vault-Notiz.');
      ids.add(note.id);
    }
    // Discover marker identities as well as legacy paths. This also recovers a completed
    // rename if a process stopped before writing the state file.
    const occupied = new Set(), found = new Map();
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      occupied.add(windowsKey(entry.name));
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.endsWith('.incoming.md')) continue;
      const current = await readNote(path.join(target, entry.name));
      const matches = [...current.matchAll(/<!-- HEC-STUDIO:([a-z-]+-[a-f0-9-]{36}):START -->/g)];
      for (const match of matches) {
        if (found.has(match[1])) throw new Error('Mehrere Vault-Notizen tragen dieselbe Studio-ID; Dateien blieben erhalten.');
        found.set(match[1], { name: entry.name, current });
      }
    }
    const plans = [];
    for (const note of [...payload.notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const saved = state.notes[note.id];
      if (saved?.fileName !== undefined && !safeStoredName(saved.fileName)) throw new Error('Ungültiger gespeicherter Vault-Dateiname.');
      let sourceName = saved?.fileName || found.get(note.id)?.name || `${note.id}.md`;
      let current = await readNote(path.join(target, sourceName));
      if (current === undefined && found.has(note.id)) { sourceName = found.get(note.id).name; current = found.get(note.id).current; }
      let fileName = saved?.fileName;
      if (!fileName && current !== undefined && sourceName !== `${note.id}.md` && safeStoredName(sourceName)) fileName = sourceName;
      if (!fileName) {
        const base = readableBase(note); let number = 1;
        do { fileName = `${base}${number === 1 ? '' : ` (${number})`}.md`; number++; } while (occupied.has(windowsKey(fileName)));
      }
      occupied.add(windowsKey(fileName));
      plans.push({ note, sourceName, fileName, current, block: existingBlock(note.id, current), saved });
    }
    const prefix = path.relative(vaultRoot, target).split(path.sep).join('/');
    const links = new Map(plans.map(plan => [plan.note.id, `${prefix}/${plan.fileName.slice(0, -3)}`]));
    const render = note => managedBlock(note.id, note.content.replace(/\[\[([a-z-]+-[a-f0-9-]{36})(#[^\]|]*)?(\|[^\]]*)?\]\]/g,
      (original, id, anchor = '', alias = '') => links.has(id) ? `[[${links.get(id)}${anchor}${alias}]]` : original));
    // Hash-check every existing managed block before any note is migrated. Conflicted
    // notes retain their source paths, including links from other generated notes.
    for (const plan of plans) {
      if (plan.current === undefined) continue;
      const existingHash = plan.block && hash(plan.block.text);
      const expected = plan.saved?.generatedHash || hash(managedBlock(plan.note.id, plan.note.content));
      plan.conflict = !plan.block || (existingHash !== expected && existingHash !== hash(render(plan.note)));
      if (plan.conflict) links.set(plan.note.id, `${prefix}/${plan.sourceName.slice(0, -3)}`);
    }
    for (const plan of plans) {
      const { note, current, block, sourceName, fileName } = plan;
      const generated = render(note), currentHash = hash(generated), file = path.join(target, fileName), source = path.join(target, sourceName);
      result.files[note.id] = `${prefix}/${(plan.conflict ? sourceName : fileName)}`;
      if (plan.conflict) {
        const incoming = path.join(target, `${fileName.slice(0, -3)}-${currentHash.slice(0, 12)}.incoming.md`);
        const content = `${generated}\n\nKonflikt: Die vorhandene Notiz wurde manuell geändert und blieb erhalten.\n`;
        const previous = await readNote(incoming);
        if (previous === undefined) await createExclusive(incoming, content);
        else if (previous !== content) throw new Error('Fremde Konfliktdatei wird nicht überschrieben.');
        result.conflicts.push({ id: note.id, file: source, incoming }); continue;
      }
      if (current === undefined) { await createExclusive(file, `${generated}\n\n## Eigene Ergänzungen\n\n`); result.created++; }
      else {
        const next = current.slice(0, block.from) + generated + current.slice(block.to);
        if (sourceName !== fileName) {
          await createExclusive(file, next);
          if (await readNote(source) !== current) throw new Error('Die Ausgangsnotiz wurde während der Umbenennung geändert; beide Dateien blieben erhalten.');
          await fs.unlink(source); result.renamed++;
        } else if (next !== current) await atomic(file, next);
        if (hash(block.text) === currentHash) result.unchanged++; else result.updated++;
      }
      state.notes[note.id] = { ...plan.saved, generatedHash: currentHash, fileName };
    }
    state.revision = payload.revision; state.lastSyncedAt = new Date().toISOString(); await atomic(stateFile, JSON.stringify(state, null, 2));
    return result;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
