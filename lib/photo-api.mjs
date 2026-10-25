import { photoLimits,photoPresets,photoError } from './photo-review.mjs';
import { validId } from './store.mjs';

export function photoRoutes(app,photos,queue,brain,config,engineReady) {
  app.get('/api/photos/config',(req,res)=>res.json({presets:photoPresets,limits:photoLimits,provider:'codex'}));
  app.get('/api/photos',(req,res)=>res.json({sessions:photos.list().map(session=>photos.public(session)),brain:brain.status()}));
  app.post('/api/photos/from-library',async(req,res)=>{
    if(!engineReady())throw photoError('FFmpeg ist noch nicht bereit.',503);
    if(config.analysisProvider!=='codex')throw photoError('Fotos aus Videos verwenden den Codex-Betriebsmodus.',409);
    const session=await photos.create(req.body);if(session.status==='queued')queue.enqueue(session.id);res.status(202).json(photos.public(session));
  });
  app.param('photoId',(req,res,next,id)=>{if(!validId(id)||!photos.get(id))return res.status(404).json({error:'Foto-Session nicht gefunden.'});req.photo=photos.get(id);next();});
  app.get('/api/photos/:photoId',(req,res)=>res.json(photos.public(req.photo)));
  app.patch('/api/photos/:photoId/selection',async(req,res)=>res.json(photos.public(await photos.selection(req.photo.id,req.body))));
  app.post('/api/photos/:photoId/more',async(req,res)=>{const session=await photos.more(req.photo.id,req.body);if(session.status==='queued')queue.enqueue(session.id);res.status(202).json(photos.public(session));});
  app.post('/api/photos/:photoId/export',async(req,res)=>{const session=await photos.requestExport(req.photo.id,req.body);if(session.status==='export-queued')queue.enqueue(session.id);res.status(202).json(photos.public(session));});
  app.post('/api/photos/:photoId/cancel',async(req,res)=>{await photos.cancel(req.photo.id);queue.cancel(req.photo.id);await brain.cancel('photo',req.photo.id);res.json(photos.public(photos.get(req.photo.id)));});
  app.post('/api/photos/:photoId/retry',async(req,res)=>{const session=await photos.retry(req.photo.id);queue.enqueue(session.id);res.status(202).json(photos.public(session));});
  app.get('/api/photos/:photoId/evidence/:photoAssetId/:filename',(req,res)=>res.sendFile(photos.evidenceFile(req.photo.id,req.params.photoAssetId,req.params.filename)));
  app.get('/api/photos/:photoId/files/:filename',(req,res)=>{const file=photos.exportFile(req.photo.id,req.params.filename);if(req.query.download==='1')return res.download(file,req.params.filename);res.sendFile(file);});
}
