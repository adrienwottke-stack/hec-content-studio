import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { syncVault } from '../lib/vault-sync.mjs';

const scratch = path.resolve('../../work/tests');
const hash = content => createHash('sha256').update(content).digest('hex');
const block = note => `<!-- HEC-STUDIO:${note.id}:START -->\n${note.content.trimEnd()}\n<!-- HEC-STUDIO:${note.id}:END -->`;
const note = (title, body = '', prefix = 'learning') => ({ id: `${prefix}-${randomUUID()}`, content: `# ${title}\n\n${body}` });
const payload = (notes, test = false) => ({ notes, test, revision: 'fixture' });
async function fixture(t) {
  await fs.mkdir(scratch, { recursive: true });
  const vault = await fs.mkdtemp(path.join(scratch, 'vault-sync-'));
  t.after(async () => { if (!vault.startsWith(scratch + path.sep)) throw new Error('Unexpected test path'); await fs.rm(vault, { recursive: true, force: true }); });
  return vault;
}
async function legacy(vault, notes, { test = false, tails = {} } = {}) {
  const target = path.join(vault, 'Projekte/HEC/Content-Lernen', test ? 'Studio-Tests' : 'Studio-Sync');
  await fs.mkdir(target, { recursive: true });
  const state = { notes: {} };
  for (const item of notes) {
    const generated = block(item);
    await fs.writeFile(path.join(target, `${item.id}.md`), generated + (tails[item.id] || '\n\n## Eigene Ergänzungen\n\n'));
    state.notes[item.id] = { generatedHash: hash(generated) };
  }
  await fs.writeFile(path.join(target, '.hec-sync-state.json'), JSON.stringify(state));
  return target;
}

test('legacy migration preserves own text exactly and rewrites links to existing human filenames', async t => {
  const vault = await fixture(t), profile = note('Stilprofil · @adrien.e39', 'Eigene Studio-Daten.', 'profile');
  const index = note('Studio Lernstrecke · @adrien.e39', `Profil: [[${profile.id}|Profilstand]]`, 'index');
  const tail = '\r\n\r\n## Eigene Ergänzungen\r\n\r\nMein Wunsch: ruhiger Originalton. äöü\r\n';
  const target = await legacy(vault, [index, profile], { tails: { [profile.id]: tail } });
  const first = await syncVault(payload([index, profile]), { vault });
  assert.equal(first.renamed, 2); assert.equal(first.conflicts.length, 0);
  for (const item of [index, profile]) {
    assert.equal(first.files[item.id].includes(item.id), false);
    await assert.rejects(fs.access(path.join(target, `${item.id}.md`)), { code: 'ENOENT' });
  }
  const profileContent = await fs.readFile(path.join(vault, first.files[profile.id]), 'utf8');
  assert.equal(profileContent.slice(profileContent.indexOf(`<!-- HEC-STUDIO:${profile.id}:END -->`) + `<!-- HEC-STUDIO:${profile.id}:END -->`.length), tail);
  const linked = await fs.readFile(path.join(vault, first.files[index.id]), 'utf8');
  assert.ok(linked.includes(`[[${first.files[profile.id].slice(0, -3)}|Profilstand]]`));
  const before = await fs.readFile(path.join(vault, first.files[profile.id]));
  const repeat = await syncVault(payload([profile, index]), { vault });
  assert.equal(repeat.created, 0); assert.equal(repeat.updated, 0); assert.equal(repeat.renamed, 0); assert.equal(repeat.unchanged, 2);
  assert.deepEqual(await fs.readFile(path.join(vault, first.files[profile.id])), before);
  const changed = await syncVault(payload([{ ...profile, content: '# Anderer Titel\n\nNeuer belegter Inhalt.' }, index]), { vault });
  assert.equal(changed.files[profile.id], first.files[profile.id]);
  assert.ok((await fs.readFile(path.join(vault, changed.files[profile.id]), 'utf8')).endsWith(tail));
});

test('duplicate headings receive stable semantic suffixes independent of payload order', async t => {
  const vault = await fixture(t), items = [note('Probeschnitt · V1'), note('Probeschnitt · V1'), note('Probeschnitt · V1')];
  const first = await syncVault(payload(items), { vault });
  const sorted = [...items].sort((a, b) => a.id < b.id ? -1 : 1);
  assert.match(first.files[sorted[0].id], /Probeschnitt · V1\.md$/);
  assert.match(first.files[sorted[1].id], /Probeschnitt · V1 \(2\)\.md$/);
  assert.match(first.files[sorted[2].id], /Probeschnitt · V1 \(3\)\.md$/);
  const again = await syncVault(payload([...items].reverse()), { vault });
  assert.deepEqual(again.files, first.files); assert.equal(again.updated, 0);
});

test('edited generated legacy blocks conflict before rename and preserve source and personal additions', async t => {
  const vault = await fixture(t), item = note('Fotoablauf wiederverwenden', 'Original.'), target = await legacy(vault, [item]);
  const file = path.join(target, `${item.id}.md`);
  const edited = (await fs.readFile(file, 'utf8')).replace('Original.', 'Manuell im Studio-Bereich geändert.') + 'Eigene Ergänzung.';
  await fs.writeFile(file, edited);
  const first = await syncVault(payload([item]), { vault });
  assert.equal(first.renamed, 0); assert.equal(first.conflicts.length, 1);
  assert.equal(await fs.readFile(file, 'utf8'), edited);
  assert.equal(first.conflicts[0].file, file); assert.equal(path.basename(first.conflicts[0].incoming).includes(item.id), false);
  const repeat = await syncVault(payload([item]), { vault });
  assert.equal(repeat.conflicts[0].incoming, first.conflicts[0].incoming);
  assert.equal(await fs.readFile(file, 'utf8'), edited);
});

test('Windows path characters, reserved names and title UUIDs cannot enter generated filenames', async t => {
  const vault = await fixture(t), items = [note('CON'), note('A/B: C? <D> | E* \\ F.'), note(`Erkenntnis ${randomUUID()}`), note('x'.repeat(300))];
  const result = await syncVault(payload(items), { vault });
  assert.match(result.files[items[0].id], /Notiz - CON\.md$/);
  for (const file of Object.values(result.files)) {
    const filename = path.basename(file);
    assert.ok(filename.length <= 140);
    assert.doesNotMatch(filename, /[<>:"\\|?*\x00-\x1f]/);
    assert.doesNotMatch(filename, /[a-f0-9]{8}-[a-f0-9]{4}-/i);
    assert.ok(await fs.readFile(path.join(vault, file)));
  }
});

test('unrelated files are retained and an unrelated persisted target is refused as a conflict', async t => {
  const vault = await fixture(t), item = note('Mein Titel'), target = path.join(vault, 'Projekte/HEC/Content-Lernen/Studio-Sync');
  await fs.mkdir(target, { recursive: true });
  const unrelated = path.join(target, 'Mein Titel.md'); await fs.writeFile(unrelated, 'Meine eigene Notiz.');
  const first = await syncVault(payload([item]), { vault });
  assert.match(first.files[item.id], /Mein Titel \(2\)\.md$/);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'Meine eigene Notiz.');
  const generated = path.join(vault, first.files[item.id]); await fs.writeFile(generated, 'Eine fremde Notiz am gespeicherten Pfad.');
  const second = await syncVault(payload([item]), { vault });
  assert.equal(second.conflicts.length, 1); assert.equal(await fs.readFile(generated, 'utf8'), 'Eine fremde Notiz am gespeicherten Pfad.');
});

test('real and test notes with identical headings use separate full links and retain test tails', async t => {
  const vault = await fixture(t), real = note('Stilprofil'), synthetic = { ...real }, index = note('Studio Lernstrecke', `[[${real.id}]]`, 'index');
  const testTail = '\n\n## Eigene Ergänzungen\n\nManuelle TEST-Ergänzung muss erhalten bleiben.\n';
  await legacy(vault, [synthetic, index], { test: true, tails: { [synthetic.id]: testTail } });
  const production = await syncVault(payload([real, index]), { vault });
  const testResult = await syncVault(payload([synthetic, index], true), { vault });
  assert.equal(testResult.renamed, 2);
  const testProfile = await fs.readFile(path.join(vault, testResult.files[synthetic.id]), 'utf8');
  assert.ok(testProfile.endsWith(testTail));
  const realIndex = await fs.readFile(path.join(vault, production.files[index.id]), 'utf8');
  const testIndex = await fs.readFile(path.join(vault, testResult.files[index.id]), 'utf8');
  assert.ok(realIndex.includes(`[[${production.files[real.id].slice(0, -3)}]]`));
  assert.ok(testIndex.includes(`[[${testResult.files[synthetic.id].slice(0, -3)}]]`));
  assert.ok(await fs.readFile(path.join(vault, production.files[real.id])));
});
