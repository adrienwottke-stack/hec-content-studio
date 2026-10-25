import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readVaultContext } from '../lib/vault-context.mjs';

const scratch = path.resolve('../../work/tests');
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const vault = await fs.mkdtemp(path.join(scratch, 'vault-context-'));
  t.after(async () => {
    const resolved = path.resolve(vault), expected = path.resolve(scratch);
    if (!resolved.startsWith(expected + path.sep)) throw new Error('Unexpected test path');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const root = path.join(vault, 'Projekte', 'HEC', 'Content-Lernen');
  await fs.mkdir(root, { recursive: true });
  return { vault, root, write: async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); return file; } };
}

test('reads current manual HEC notes and preserves their bytes', async t => {
  const { vault, write } = await fixture(t);
  const file = await write('01-HEC-Stilprofil.md', '# Stil\n\nAb jetzt kürzere Einstiege.\n');
  await write('00-HEC-Content-Lernen.md', '# Kontext\n\nKonto adrien.e39.');
  const before = await fs.readFile(file), first = await readVaultContext({ vault });
  assert.equal(first.notes[0].relativePath, 'Projekte/HEC/Content-Lernen/00-HEC-Content-Lernen.md');
  assert.match(first.notes[1].content, /kürzere Einstiege/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.match(first.notes[1].sourceId, /^obsidian:Projekte\/HEC\/Content-Lernen\/01-HEC-Stilprofil\.md:[a-f0-9]{16}$/);
  const repeated = await readVaultContext({ vault });
  assert.equal(repeated.revision, first.revision);
  await fs.appendFile(file, '\nFeedback: sofort die sichtbare Aktion.\n');
  const changed = await readVaultContext({ vault });
  assert.notEqual(changed.notes[1].sourceId, first.notes[1].sourceId);
  assert.match(changed.notes[1].content, /sofort die sichtbare Aktion/);
});

test('ignores fixtures, templates and conflict files; reads only own additions from generated notes', async t => {
  const { vault, write } = await fixture(t);
  const id = 'version-12345678-1234-1234-1234-123456789abc';
  const generated = `<!-- HEC-STUDIO:${id}:START -->\nPRIVATE GENERATED FEEDBACK\n<!-- HEC-STUDIO:${id}:END -->`;
  await write('Studio-Tests/test.md', 'TEST MUST NOT ENTER');
  await write('Vorlagen/template.md', 'TEMPLATE MUST NOT ENTER');
  await write('manual.incoming.md', 'CONFLICT MUST NOT ENTER');
  await write('marked-test.md', '---\nis_test: true\n---\n\nTEST MARKED MUST NOT ENTER');
  await write('Studio-Sync/without-additions.md', `${generated}\n\n## Eigene Ergänzungen\n\n`);
  const ownFile = await write('Studio-Sync/with-additions.md', `${generated}\n\n## Eigene Ergänzungen\n\nMein eigener Wunsch: ruhiger Originalton.\n`);
  const before = await fs.readFile(ownFile), result = await readVaultContext({ vault });
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0].content, /ruhiger Originalton/);
  assert.doesNotMatch(result.notes[0].content, /GENERATED|TEST|TEMPLATE|CONFLICT/);
  assert.deepEqual(await fs.readFile(ownFile), before);
});

test('bounds per-note and total bytes and reports omitted or truncated context', async t => {
  const { vault, write } = await fixture(t);
  await write('00-HEC-Content-Lernen.md', 'ä'.repeat(100));
  await write('01-HEC-Stilprofil.md', 'b'.repeat(100));
  await write('02-HEC-Lernlog.md', 'c'.repeat(100));
  const result = await readVaultContext({ vault, maxNoteBytes: 21, maxTotalBytes: 30 });
  assert.ok(result.notes.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) <= 30);
  assert.ok(result.notes.every(item => Buffer.byteLength(item.content) <= 21));
  assert.ok(result.notes.some(item => item.truncated));
  assert.ok(result.notes.every(item => !item.content.includes('\uFFFD')));
  assert.ok(result.warnings.length > 0);
});

test('oversized files and malformed generated blocks are omitted with a clear warning', async t => {
  const { vault, write } = await fixture(t);
  await write('large.md', 'x'.repeat(101));
  await write('broken.md', '<!-- HEC-STUDIO:broken:START -->\nUnclosed block');
  const result = await readVaultContext({ vault, maxInputBytes: 100 });
  assert.equal(result.notes.length, 0);
  assert.ok(result.warnings.some(value => /große Quelldatei/.test(value)));
  assert.ok(result.warnings.some(value => /Unvollständiger/.test(value)));
});

test('linked directories cannot introduce notes from outside the HEC folder', async t => {
  const { vault, root, write } = await fixture(t);
  await write('00-HEC-Content-Lernen.md', 'Permitted context');
  const outside = path.join(vault, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.md'), 'OUTSIDE MUST NOT ENTER');
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not allow test symlinks'); return; } throw error; }
  const result = await readVaultContext({ vault });
  assert.equal(result.notes.length, 1);
  assert.ok(result.warnings.some(value => /Verknüpfte Quelle/.test(value)));
  assert.doesNotMatch(JSON.stringify(result.notes), /OUTSIDE/);
});
