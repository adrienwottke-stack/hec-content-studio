import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { fail, text, digest, csvHeader } from './content-validation.mjs';

function evidenceType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['png', 'image/png'];
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return ['jpg', 'image/jpeg'];
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return ['webp', 'image/webp'];
  if (buffer.subarray(0, 5).toString() === '%PDF-') return ['pdf', 'application/pdf'];
  if (buffer.length && !buffer.includes(0) && buffer.toString('utf8').includes(';') && !/<(?:html|script|svg)\b/i.test(buffer.toString('utf8'))) return ['csv', 'text/csv'];
  throw fail('Als Beleg PNG, JPEG, WebP, PDF oder einen CSV-Export verwenden.');
}

export function contentRoutes(app, service, meta, config, capacity, transfers) {
  const content = service.content;
  app.get('/api/content', async (req, res) => {
    const data = await service.snapshot({ test: req.query.test === 'true' });
    const availableCollections = [...new Set(service.library.list().filter(item => !item.archived).flatMap(item => item.collections))].sort();
    res.json({ ...data, availableCollections, meta: meta.public() });
  });
  app.patch('/api/content/accounts/:accountId', async (req, res) => res.json(await content.accountUpdate(req.params.accountId, req.body)));
  app.post('/api/content/accounts/:accountId/style', async (req, res) => res.json(await content.styleUpdate(req.params.accountId, req.body)));
  app.post('/api/content/collections', async (req, res) => {
    const names = [...new Set(service.library.list().filter(item => !item.archived).flatMap(item => item.collections))];
    res.json(await content.collectionUpdate(req.body, names));
  });
  app.post('/api/content/drafts', async (req, res) => { const version = await content.reserveDraft(req.body, service.library.list()); await service.dispatch(); res.status(202).json({ version: content.version(version.id) }); });
  app.post('/api/content/versions/:versionId/review', async (req, res) => { const result = await content.review(req.params.versionId, req.body); await service.dispatch(); res.status(result.revision ? 202 : 200).json(result); });
  app.post('/api/content/versions/:versionId/retry', async(req,res)=>res.json(await service.retry(req.params.versionId)));
  app.post('/api/content/learning/:runId/retry',async(req,res)=>{
    const run=await content.transaction(state=>{const item=state.learningRuns.find(item=>item.id===req.params.runId);if(!item||item.status!=='error')throw fail('Dieser Lernlauf benötigt keinen Retry.',409);item.status='queued';item.error=null;return item;});
    await service.brain.prepareLearning(run);res.status(202).json({ok:true,runId:run.id});
  });
  app.get('/api/content/versions/:versionId', async (req, res) => { await service.snapshot({ test: true }); res.json(content.version(req.params.versionId)); });
  app.post('/api/content/publications', async (req, res) => res.status(201).json(await content.publication(req.body)));
  app.post('/api/content/publications/:publicationId/mapping', async (req, res) => res.json(await content.mapPublication(req.params.publicationId, req.body)));
  app.post('/api/content/measurements', async (req, res) => res.status(201).json(await content.measurement(req.body)));
  app.post('/api/content/imports', async (req, res) => res.json(await content.importCsv(req.body)));
  app.get('/api/content/import-template.csv', (req, res) => { res.type('text/csv'); res.attachment('HEC_Insights_Importvorlage.csv'); res.send(`\uFEFF${csvHeader}\r\n`); });
  app.post('/api/content/references', async (req, res) => res.status(201).json(await content.reference(req.body)));
  app.post('/api/content/run', async (req, res) => res.json(await service.tick({ learning: req.body.learning !== false, autopilot: req.body.autopilot !== false, test: req.body.test === true })));
  app.get('/api/content/brief', (req, res) => res.json(content.brief(req.query.accountId, { collection: req.query.collection || '', isTest: req.query.test === 'true', topics: req.query.topic ? [req.query.topic] : [] })));
  app.get('/api/content/knowledge', (req, res) => res.json(service.knowledge({ test: req.query.test === 'true', base: config.publicUrl })));
  app.post('/api/content/evidence', express.raw({ type: 'application/octet-stream', limit: '12mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail('Ein Beleg fehlt.');
    const size = req.body.length, sha256 = digest(req.body), isTest = req.query.test === 'true';
    const [extension, mime] = evidenceType(req.body), evidenceId = randomUUID(), filename = `${evidenceId}.${extension}`, root = path.join(content.root, 'evidence');
    await capacity.require(size, transfers.reserved()); await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const result = await content.transaction(async state => {
      const previous = state.evidence.find(item => item.sha256 === sha256 && item.isTest === isTest); if (previous) return previous;
      if (state.evidence.length >= 2000) throw fail('Die Belegsammlung ist voll; zuerst den Speicher prüfen.');
      const name = text(req.get('x-evidence-name') ? decodeURIComponent(req.get('x-evidence-name')) : `Beleg.${extension}`, 200, 'Belegname').replace(/[\r\n\\/]/g, '_');
      await fs.writeFile(path.join(root, filename), req.body, { mode: 0o600, flag: 'wx' });
      const evidence = { id: evidenceId, filename, name, mime, size, sha256, isTest, createdAt: new Date().toISOString() }; state.evidence.push(evidence); return evidence;
    });
    const { filename: privateName, ...visible } = result; res.status(201).json({ ...visible, url: `/api/content/evidence/${result.id}` });
  });
  app.get('/api/content/evidence/:evidenceId', (req, res) => {
    const evidence = content.state.evidence.find(item => item.id === req.params.evidenceId); if (!evidence) throw fail('Beleg nicht gefunden.', 404);
    res.type(evidence.mime); res.setHeader('Content-Disposition', `attachment; filename="beleg-${evidence.id}.${evidence.filename.split('.').at(-1)}"`);
    res.sendFile(path.join(content.root, 'evidence', evidence.filename));
  });
  app.get('/api/content/meta/status', (req, res) => res.json(meta.public()));
  app.post('/api/content/meta/config', async (req, res) => res.json(await meta.configure(req.body)));
  app.post('/api/content/meta/connect', async (req, res) => {
    const result = await meta.begin(); res.cookie('hec_meta_nonce', result.cookie, { httpOnly: true, secure: config.production, sameSite: 'lax', path: '/oauth/meta/callback', maxAge: 15 * 60000 });
    res.json({ url: result.url });
  });
  app.post('/api/content/meta/disconnect', async (req, res) => res.json(await meta.disconnect()));
  app.get('/api/content/meta/media', async (req, res) => res.json({ media: await meta.media() }));
  app.post('/api/content/meta/read', async (req, res) => res.json(await meta.read(req.body.publicationId)));
  app.get('/oauth/meta/callback', async (req, res) => {
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('hec_meta_nonce='))?.slice(15);
    await meta.callback(req.query, cookie); res.clearCookie('hec_meta_nonce', { path: '/oauth/meta/callback', sameSite: 'lax', secure: config.production });
    res.redirect(303, '/?view=learn&meta=checked');
  });
}
