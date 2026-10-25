import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { configuration } from './lib/config.mjs';
import { JobStore, validId } from './lib/store.mjs';
import { RenderQueue } from './lib/queue.mjs';
import { run } from './lib/process.mjs';
import { MediaLibrary, libraryFields, linkOriginal } from './lib/library.mjs';
import { LibraryQueue } from './lib/library-queue.mjs';
import { SerialMedia } from './lib/serial-media.mjs';
import { categories } from './lib/catalog.mjs';
import { receiveVideos } from './lib/upload.mjs';
import { CodexBrain } from './lib/codex-brain.mjs';
import { StorageCapacity } from './lib/storage.mjs';
import { LibraryTransfers } from './lib/transfers.mjs';
import { PhotoStore } from './lib/photo-store.mjs';
import { PhotoQueue } from './lib/photo-queue.mjs';
import { photoRoutes } from './lib/photo-api.mjs';
import { ContentService } from './lib/content-service.mjs';
import { contentRoutes } from './lib/content-api.mjs';
import { MetaInsights } from './lib/meta-insights.mjs';
import { getStyleProfile, styleProfiles } from './lib/style-profiles.mjs';
import { attachMusicApi, normalizeMusicId } from './lib/music.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = text => createHash('sha256').update(text).digest();
const equal = (left, right) => timingSafeEqual(hash(String(left)), hash(String(right)));

function cookieToken(config) {
  const payload = Buffer.from(JSON.stringify({ until: Date.now() + 8 * 3600_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', config.password).update(`hec-studio:${payload}`).digest('base64url')}`;
}

function authenticated(req, config) {
  if (!config.password) return true;
  const basic = req.headers.authorization;
  if (basic?.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator >= 0 && equal(decoded.slice(0, separator), config.username) && equal(decoded.slice(separator + 1), config.password)) return true;
  }
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('hec_session='))?.slice(12);
  if (!value) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = createHmac('sha256', config.password).update(`hec-studio:${payload}`).digest('base64url');
  if (!equal(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isFinite(data.until) && data.until > Date.now() && data.until < Date.now() + 8 * 3600_000 + 5000;
  } catch { return false; }
}

export async function createStudio(config, dependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const store = new JobStore(config.dataDir);
  await store.initialize();
  const settingsPath = path.join(config.dataDir, 'provider-settings.json');
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (typeof settings.apiKey === 'string' && typeof settings.model === 'string') {
      config.apiKey = settings.apiKey; config.model = settings.model;
    }
  } catch (error) { if (error.code !== 'ENOENT') console.error('Gespeicherte Videoanalyse-Einstellungen konnten nicht gelesen werden.'); }
  const library = new MediaLibrary(config.dataDir);
  await library.initialize();
  await library.importJobs(store);
  const serial = new SerialMedia();
  const photos=new PhotoStore(config.dataDir,library,config);await photos.initialize();
  const brain = new CodexBrain(library,store,config,serial,{...dependencies,photos});
  await brain.initialize();
  const queue = new RenderQueue(store, config, { ...dependencies, serial, brain });
  brain.onPlanReady=id=>queue.enqueue(id);
  const photoQueue=new PhotoQueue(photos,library,config,serial,{...dependencies,brain});
  brain.photoQueue=photoQueue;brain.onPhotoReady=id=>photoQueue.enqueue(id);
  const libraryQueue = new LibraryQueue(library, config, serial, {...dependencies,brain});
  const capacity=new StorageCapacity(config,library,dependencies);
  const transfers=new LibraryTransfers(config,library,capacity,id=>libraryQueue.enqueue(id));
  await transfers.initialize();
  const contentService = new ContentService(config, library, store, queue, brain, dependencies);
  await contentService.initialize();
  brain.contentService = contentService;
  queue.onStatus = job => contentService.observe(job);
  const meta = new MetaInsights(config, contentService.content, dependencies); await meta.initialize();
  const analysisAvailable=()=>config.analysisProvider==='codex'||Boolean(config.apiKey);
  const cutOptions=fields=>normalizeOptions({...fields,mode:fields.mode==='quick'?'quick':config.analysisProvider==='codex'?'codex':fields.mode});
  let uploadBusy = false;
  let engineReady = false;
  try {
    await run(config.ffmpeg, ['-version'], { timeout: 15_000 });
    await run(config.ffprobe, ['-version'], { timeout: 15_000 });
    engineReady = true;
  } catch { console.error('FFmpeg oder ffprobe ist nicht verfügbar.'); }
  const failedLogins = new Map();
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.get('x-reel-studio') !== '1') return res.status(403).json({ error: 'Diese Anfrage muss aus dem Reel-Studio kommen.' });
      if (req.get('origin')) {
        try { if (new URL(req.get('origin')).host !== req.get('host')) throw new Error(); }
        catch { return res.status(403).json({ error: 'Die Herkunft der Anfrage ist ungültig.' }); }
      }
    }
    next();
  });
  app.use(express.json({ limit: '2200kb' }));
  app.get('/api/health', (req, res) => res.json({ ok: true, engine: engineReady }));
  app.post('/api/login', (req, res) => {
    const address = req.ip;
    const previous = failedLogins.get(address);
    const recent = previous && Date.now() - previous.since < 600_000 ? previous : { count: 0, since: Date.now() };
    if (recent.count >= 12) return res.status(429).json({ error: 'Zu viele Anmeldeversuche. Bitte in zehn Minuten erneut versuchen.' });
    if (config.password && !equal(req.body?.password || '', config.password)) {
      recent.count++;
      failedLogins.set(address, recent);
      // Keep a bounded map, even on hosts with many clients.
      if (failedLogins.size > 1000) failedLogins.delete(failedLogins.keys().next().value);
      return res.status(401).json({ error: 'Das Passwort stimmt nicht.' });
    }
    failedLogins.delete(address);
    if (config.password) res.cookie('hec_session', cookieToken(config), { httpOnly: true,
      sameSite: 'strict', secure: config.production, maxAge: 8 * 3600_000, path: '/' });
    return res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    if (!authenticated(req, config)) return res.status(401).json({ error: 'Bitte anmelden.', loginRequired: true });
    next();
  });
  attachMusicApi(app, config);
  app.post('/api/logout', (req, res) => { res.clearCookie('hec_session', { path: '/' }); res.json({ ok: true }); });
  app.post('/api/settings/analysis', async (req, res) => {
    if(config.analysisProvider==='codex')return res.status(409).json({error:'Dieses Studio nutzt die Codex-Anbindung. Ein Anbieter-Schlüssel ist nicht erforderlich.'});
    const key = req.body?.key;
    if (typeof key !== 'string' || key.length < 20 || key.length > 256 || /\s/.test(key)) {
      return res.status(400).json({ error: 'Bitte einen gültigen Gemini-API-Schlüssel eingeben.' });
    }
    if (queue.running || libraryQueue.running || uploadBusy) return res.status(409).json({ error: 'Bitte die laufende Verarbeitung abwarten.' });
    try {
      const result = await fetch(`${config.providerBase}/v1beta/models/${encodeURIComponent(config.model)}`, {
        headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok) return res.status(400).json({ error: `Google bestätigt den Modellzugriff nicht (HTTP ${result.status}). Schlüssel, Freigabe und Modell prüfen.` });
      await fs.writeFile(settingsPath, JSON.stringify({ apiKey: key, model: config.model }), { mode: 0o600 });
      config.apiKey = key;
      res.json({ ok: true });
    } catch { res.status(502).json({ error: 'Google ist gerade nicht erreichbar. Die Verbindung wurde nicht gespeichert.' }); }
  });
  app.get('/api/config', (req, res) => res.json({ engineReady, analysisReady: analysisAvailable(),analysisProvider:config.analysisProvider,brain:brain.status(),
    authenticated: Boolean(config.password), maxFiles: config.maxFiles,
    maxFileMB: config.maxFileBytes / 1024 ** 2, maxSessionMB: config.maxSessionBytes / 1024 ** 2,
    uploadChunkMB:config.uploadChunkBytes/1024**2,resumableUploads:true,
    resolution: `${config.width} × ${Math.round(config.width * 16 / 9 / 2) * 2}`, categories, styleProfiles, photosReady:config.analysisProvider==='codex', version: '0.7.0' }));
  app.get('/api/brain/status',(req,res)=>res.json(brain.status()));
  app.get('/api/brain/work',(req,res)=>res.json({status:brain.status(),requests:brain.work()}));
  app.post('/api/brain/heartbeat',async(req,res)=>{await brain.heartbeat(req.body.worker);res.json(brain.status());});
  app.post('/api/brain/:requestId/claim',async(req,res)=>res.json(await brain.claim(req.params.requestId,req.body.worker)));
  app.post('/api/brain/:requestId/renew',async(req,res)=>res.json(await brain.renew(req.params.requestId,req.body.token)));
  app.post('/api/brain/:requestId/frame',async(req,res)=>res.json(await brain.frame(req.params.requestId,req.body.token,req.body.assetId,req.body.at)));
  app.post('/api/brain/:requestId/window',async(req,res)=>res.status(202).json(await brain.window(req.params.requestId,req.body.token,req.body.window)));
  app.get('/api/brain/:requestId/window/:windowId',(req,res)=>res.json(brain.windowStatus(req.params.requestId,req.params.windowId)));
  app.post('/api/brain/:requestId/complete',async(req,res)=>res.json(await brain.complete(req.params.requestId,req.body.token,req.body.result)));
  app.post('/api/brain/:requestId/fail',async(req,res)=>res.json(await brain.fail(req.params.requestId,req.body.token,req.body.error)));
  app.get('/api/brain/:requestId/files/:assetId/:filename',(req,res)=>res.sendFile(brain.file(req.params.requestId,req.params.assetId,req.params.filename)));
  photoRoutes(app,photos,photoQueue,brain,config,()=>engineReady);
  contentRoutes(app,contentService,meta,config,capacity,transfers);
  app.get('/api/jobs', (req, res) => res.json({ jobs: store.list().map(job => store.public(job)) }));
  app.get('/api/library', async (req,res) => res.json({ clips:library.list().map(clip=>library.public(clip)),categories,
    storage:await capacity.snapshot(transfers.reserved()),analysisReady:analysisAvailable(),analysisProvider:config.analysisProvider,brain:brain.status() }));
  app.get('/api/library/index.json', (req,res) => {
    res.setHeader('Content-Disposition','attachment; filename="hec-footage-index.json"');
    res.json({exportedAt:new Date().toISOString(),clips:library.list().map(clip=>library.public(clip))});
  });
  const transferWrite=handler=>async(req,res,next)=>{
    if(uploadBusy)return res.status(429).json({error:'Ein Upload-Teil wird gerade gespeichert. Bitte kurz abwarten.'});
    uploadBusy=true;
    try{await handler(req,res);}catch(error){next(error);}finally{uploadBusy=false;}
  };
  app.post('/api/library/transfers',transferWrite(async(req,res)=>res.status(201).json(await transfers.start(req.body))));
  app.get('/api/library/transfers/:transferId',(req,res)=>res.json(transfers.public(transfers.get(req.params.transferId))));
  app.patch('/api/library/transfers/:transferId/chunks',transferWrite(async(req,res)=>res.json(await transfers.append(
    req.params.transferId,Number(req.query.offset),Number(req.get('x-chunk-size')),req.get('x-chunk-sha256'),req))));
  app.post('/api/library/transfers/:transferId/finish',transferWrite(async(req,res)=>res.json(await transfers.finish(req.params.transferId))));
  app.delete('/api/library/transfers/:transferId',transferWrite(async(req,res)=>res.json(await transfers.discard(req.params.transferId))));
  app.post('/api/library/uploads', async (req,res) => {
    if(!engineReady) return res.status(503).json({error:'Der Schnittdienst ist noch nicht bereit.'});
    if(uploadBusy) return res.status(429).json({error:'Ein Upload läuft bereits. Bitte kurz abwarten.'});
    uploadBusy=true;
    const staging=path.join(library.root,'.uploads',randomUUID());
    try {
      const storage=await capacity.require(1,transfers.reserved());
      const {assets,fields}=await receiveVideos(req,staging,{...config,maxStorageBytes:library.bytes()+storage.availableBytes},library.bytes());
      libraryFields(fields);
      const saved=[]; let duplicates=0;
      for(const asset of assets) {
        const result=await library.adopt(asset,fields); saved.push(result.clip);
        if(result.duplicate) duplicates++; else libraryQueue.enqueue(result.clip.id);
      }
      res.status(202).json({clips:[...new Map(saved.map(clip=>[clip.id,library.public(clip)])).values()],duplicates});
    } catch(error) { res.status(error.status||400).json({error:error.message.slice(0,400)}); }
    finally {
      if(!path.resolve(staging).startsWith(library.root+path.sep)) throw new Error('Ungültiges Upload-Verzeichnis.');
      await fs.rm(staging,{recursive:true,force:true}); uploadBusy=false;
    }
  });
  app.post('/api/library/analyze',async(req,res)=>{
    if(!analysisAvailable()) return res.status(503).json({error:'Bitte zuerst die Videoanalyse verbinden.'});
    const clips=library.list().filter(clip=>!clip.archived&&clip.status==='ready'&&!['done','waiting-codex','preparing-codex'].includes(clip.analysisStatus)).slice(0,12);
    for(const clip of clips) { await library.update(clip.id,{status:'queued',stage:'Wartet auf die Inhaltssortierung.'}); libraryQueue.enqueue(clip.id); }
    res.status(202).json({queued:clips.length});
  });
  app.param('assetId',(req,res,next,id)=>{
    if(!validId(id)||!library.get(id)) return res.status(404).json({error:'Aufnahme nicht gefunden.'});
    req.clip=library.get(id); next();
  });
  app.get('/api/library/:assetId',(req,res)=>res.json(library.public(req.clip)));
  app.patch('/api/library/:assetId',async(req,res)=>{
    try { res.json(library.public(await library.edit(req.clip.id,req.body))); }
    catch(error) { res.status(400).json({error:error.message.slice(0,400)}); }
  });
  app.post('/api/library/:assetId/analyze',async(req,res)=>{
    if(req.clip.status==='processing'||libraryQueue.waiting.includes(req.clip.id)) return res.status(409).json({error:'Die Aufnahme wird bereits verarbeitet.'});
    if(req.clip.previewReady&&!analysisAvailable()) return res.status(503).json({error:'Bitte zuerst die Videoanalyse verbinden.'});
    if(req.clip.analysisStatus==='waiting-codex')return res.status(409).json({error:'Die Aufnahme wartet bereits auf Codex.'});
    await library.update(req.clip.id,{status:'queued',stage:'Wartet auf die Vorbereitung und Einordnung.'}); libraryQueue.enqueue(req.clip.id);
    res.status(202).json({ok:true});
  });
  app.get('/api/library/:assetId/files/:kind',(req,res)=>{
    const kind=req.params.kind;
    const file=kind==='original'?req.clip.path:kind==='preview'&&req.clip.previewReady?path.join(library.directory(req.clip.id),'preview.mp4'):
      kind==='poster'&&req.clip.previewReady?path.join(library.directory(req.clip.id),'poster.jpg'):null;
    if(!file) return res.status(404).json({error:'Datei nicht gefunden.'});
    if(req.query.download==='1' && kind==='original') return res.download(file,req.clip.name);
    res.sendFile(file);
  });
  let libraryJobCreation=Promise.resolve();
  app.post('/api/jobs/from-library',async(req,res)=>{
    // A repeated background task must create exactly the same job, even if the
    // first response was lost or simultaneous requests reach the server.
    const previous=libraryJobCreation;let release;
    libraryJobCreation=new Promise(resolve=>{release=resolve;});await previous;
    let id,created=false;
    try {
      if(req.body?.requestId!==undefined&&!validId(req.body.requestId)) throw new Error('Ungültige Auftragsreferenz.');
      id=req.body?.requestId||randomUUID();
      const ids=req.body?.assetIds;
      if(!Array.isArray(ids)||!ids.length||ids.length>config.maxFiles||new Set(ids).size!==ids.length) throw new Error(`Bitte eine bis ${config.maxFiles} unterschiedliche Aufnahmen für diesen Schnitt auswählen.`);
      const options=cutOptions(req.body);
      const requestHash=createHash('sha256').update(JSON.stringify({ids,options})).digest('hex');
      const existing=store.get(id);
      if(existing) {
        if(existing.requestHash!==requestHash) return res.status(409).json({error:'Diese Auftragsreferenz wurde bereits für einen anderen Schnitt verwendet.'});
        return res.status(202).json(store.public(existing));
      }
      if(!engineReady) return res.status(503).json({error:'Der Schnittdienst ist noch nicht bereit.'});
      if(store.list().filter(job=>['queued','processing','waiting-brain'].includes(job.status)).length>=5) return res.status(429).json({error:'Die Warteschlange ist voll. Du kannst diese Upload-Aufgabe später fortsetzen.'});
      if(options.mode==='ai'&&!config.apiKey) throw new Error('Bitte zuerst die Videoanalyse verbinden.');
      const clips=ids.map(assetId=>{
        const clip=validId(assetId)?library.get(assetId):null;
        if(!clip||clip.archived||!['ready','queued','processing'].includes(clip.status)) throw new Error('Eine ausgewählte Aufnahme ist nicht verfügbar. Bitte die Vorbereitung in der Bibliothek prüfen.');
        return clip;
      });
      const inputs=path.join(store.directory(id),'inputs');created=true; await fs.mkdir(inputs,{recursive:true});
      const assets=[];
      for(const clip of clips) {
        const target=path.join(inputs,`${clip.id}${clip.extension}`); await linkOriginal(clip.path,target);
        const indexed=library.public(clip);
        assets.push({id:clip.id,libraryId:clip.id,name:clip.name,path:target,size:clip.size,sha256:clip.sha256,duration:clip.duration,width:clip.width,height:clip.height,audio:clip.audio,
          catalog:{title:indexed.title,category:indexed.category,tags:indexed.tags,description:indexed.description,moments:indexed.moments,basis:indexed.classificationSource}});
      }
      const now=new Date().toISOString();
      const job=await store.create({id,requestHash,createdAt:now,updatedAt:now,title:options.title,options,assets,status:'queued',stage:'Wartet auf den Schnittdienst.',progress:0,outputs:[]});
      await contentService.attach(job);
      queue.enqueue(id); res.status(202).json(store.public(job));
    } catch(error) { if(created)await store.remove(id); res.status(400).json({error:error.message.slice(0,400)}); }
    finally {release();}
  });
  app.param('id', (req, res, next, id) => {
    if (!validId(id) || !store.get(id)) return res.status(404).json({ error: 'Session nicht gefunden.' });
    req.job = store.get(id); next();
  });
  app.get('/api/jobs/:id', (req, res) => res.json(store.public(req.job)));
  app.post('/api/jobs', async (req, res) => {
    if (!engineReady) return res.status(503).json({ error: 'Der Schnittdienst ist noch nicht bereit. FFmpeg und ffprobe prüfen.' });
    if (store.list().filter(job => ['queued', 'processing','waiting-brain'].includes(job.status)).length >= 5) {
      return res.status(429).json({ error: 'Die Warteschlange ist voll. Bitte eine laufende Session abwarten.' });
    }
    if (uploadBusy) return res.status(429).json({ error: 'Ein Upload läuft bereits. Bitte kurz abwarten.' });
    const existingBytes = library.bytes();
    const id = randomUUID();
    const directory = store.directory(id);
    const inputs = path.join(directory, 'inputs');
    await fs.mkdir(inputs, { recursive: true });
    uploadBusy = true;
    try {
      const storage=await capacity.require(1,transfers.reserved());
      const { assets, fields } = await receiveVideos(req, inputs, {...config,maxStorageBytes:existingBytes+storage.availableBytes}, existingBytes);
      const options = cutOptions(fields);
      if (options.mode === 'ai' && !config.apiKey) throw new Error('Videoanalyse ist noch nicht verbunden. Für einen technischen Test den Probeschnitt auswählen.');
      const added = [];
      for (const asset of assets) {
        const result = await library.adopt(asset, { collection: options.title, brief: options.brief });
        asset.libraryId = result.clip.id;
        if (result.duplicate) { await fs.unlink(asset.path); await linkOriginal(result.clip.path, asset.path); }
        else added.push(result.clip.id);
      }
      const now = new Date().toISOString();
      const job = await store.create({ id, createdAt: now, updatedAt: now,
        title: options.title, options, assets, status: 'queued', stage: 'Wartet auf den Schnittdienst.', progress: 0, outputs: [] });
      await contentService.attach(job);
      queue.enqueue(id);
      for (const assetId of added) libraryQueue.enqueue(assetId);
      res.status(202).json(store.public(job));
    } catch (error) {
      await store.remove(id);
      res.status(400).json({ error: error.message.slice(0, 400) });
    } finally { uploadBusy = false; }
  });
  app.post('/api/jobs/:id/retry', async (req, res) => {
    if (!['error', 'cancelled'].includes(req.job.status)) return res.status(409).json({ error: 'Diese Session kann gerade nicht erneut gestartet werden.' });
    if (req.job.options.mode === 'ai' && !analysisAvailable()) return res.status(503).json({ error: 'Videoanalyse ist noch nicht verbunden.' });
    if (queue.waiting.length >= 5) return res.status(429).json({ error: 'Die Warteschlange ist voll.' });
    await store.update(req.job.id, { status: 'queued', stage: 'Wartet auf den Schnittdienst.', error: null, progress: 0 });
    queue.enqueue(req.job.id);
    res.json(store.public(req.job));
  });
  app.post('/api/jobs/:id/cancel', async (req, res) => {
    if (!['queued', 'processing','waiting-brain'].includes(req.job.status)) return res.status(409).json({ error: 'Diese Session läuft gerade nicht.' });
    await brain.cancel('job',req.job.id);
    queue.cancel(req.job.id);
    if (['queued','waiting-brain'].includes(req.job.status)) await store.update(req.job.id, { status: 'cancelled', stage: 'Abgebrochen.', progress: 0 });
    res.json({ ok: true });
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    if(contentService.protectedJob(req.job.id)) return res.status(409).json({error:'Diese Schnittversion hat Feedback, Revisionen oder Veröffentlichungen. Im Review verwerfen; Exporte und Belege bleiben erhalten.'});
    if (queue.running === req.job.id || queue.waiting.includes(req.job.id)) return res.status(409).json({ error: 'Zuerst die Verarbeitung abbrechen und abwarten.' });
    await brain.cancel('job',req.job.id);
    await store.remove(req.job.id);
    res.json({ ok: true });
  });
  app.get('/api/jobs/:id/files/:filename', (req, res) => {
    const allowed = ['plan.json', 'source-inventory.json', ...(req.job.outputs || []).flatMap(output =>
      [output.filename, output.cover, output.caption, output.timeline, output.quality, ...(output.reviewSheets || [])]).filter(Boolean)];
    if (!allowed.includes(req.params.filename)) return res.status(404).json({ error: 'Datei nicht gefunden.' });
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.sendFile(path.join(store.directory(req.job.id), 'outputs', req.params.filename));
  });
  app.use(express.static(path.join(here, 'public'), { etag: true, maxAge: 0, dotfiles: 'deny' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('HTTP:', error.message);
    res.status(error.status || 500).json({ error: error.status&&(error.status<500||error.status===507)?error.message:'Die Anfrage konnte nicht verarbeitet werden.' });
  });
  for (const job of store.list().filter(job => job.status === 'queued')) queue.enqueue(job.id);
  for (const clip of library.list().filter(clip => clip.status === 'queued')) libraryQueue.enqueue(clip.id);
  if(config.analysisProvider==='codex')for(const clip of library.list().filter(clip=>!clip.archived&&clip.status==='ready'&&!clip.brainReview&&['needs-key','pending','done'].includes(clip.analysisStatus))) {
    await library.update(clip.id,{status:'queued',analysisStatus:'preparing-codex',stage:'Wird für Codex vorbereitet.'});libraryQueue.enqueue(clip.id);
  }
  photoQueue.resume();
  if (dependencies.scheduler !== false) contentService.start();
  const metaTimer = dependencies.scheduler === false ? null : setInterval(() => meta.tick().catch(() => {}), 60000);
  metaTimer?.unref();
  return { app, store, queue, library, libraryQueue, brain, transfers, capacity, photos, photoQueue, contentService, meta, close: async () => {
    clearInterval(metaTimer); await contentService.close(); await Promise.all([queue.close(),libraryQueue.close(),photoQueue.close()]); } };
}

export function normalizeOptions(fields) {
  const mode = fields.mode === 'quick' ? 'quick' : fields.mode==='codex'?'codex':'ai';
  const count = Number(fields.count ?? 1);
  const duration = Number(fields.duration ?? 25);
  if (!Number.isInteger(count) || count < 1 || count > 3 || ![15, 25, 35, 45].includes(duration)) {
    throw new Error('Anzahl oder Länge der Reels ist ungültig.');
  }
  const title = (fields.title || 'Neue Session').trim();
  const brief = (fields.brief || '').trim();
  if (!title || title.length > 80 || brief.length > 1600) throw new Error('Name oder Kontext ist zu lang.');
  const styleProfile = getStyleProfile(fields.styleProfile).id;
  const musicId = normalizeMusicId(fields.musicId);
  return { title, brief, mode, count: mode === 'quick' ? 1 : count, duration,
    fit: fields.fit === 'fill' ? 'fill' : 'preserve', goal: ['event', 'atmosphere'].includes(fields.goal) ? fields.goal : 'followers',
    styleProfile, ...(musicId ? { musicId } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = configuration();
  const studio = await createStudio(config);
  const server = studio.app.listen(config.port, config.host, () => console.log(`HEC Reel-Studio: http://${config.host}:${config.port}`));
  server.requestTimeout = 15 * 60_000;
  const stop = async () => {
    await studio.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
