import { createHash } from 'node:crypto';
import { validId } from './store.mjs';

export const photoLimits = Object.freeze({ overviewPerAsset:96, overviewPerSession:720,
  detailPerAsset:240, detailPerSession:960, windowFrames:96, windowSeconds:30,
  rounds:5, candidates:120, maxFavorites:24 });
export const photoPresets = [
  {id:'presence',version:1,label:'Macher & Präsenz',style:'Souverän, tatkräftig und präsent. Klare Haltung, konzentrierte Aktion oder verständliche Ansprache.'},
  {id:'community',version:1,label:'Community & Energie',style:'Gemeinschaftlich, lebendig und aktiv. Verständlicher Austausch und sichtbare gemeinsame Aktivitäten.'},
  {id:'calm',version:1,label:'Ruhig & souverän',style:'Ruhig, aufmerksam und souverän. Klare Blicke, entspannte Haltung und übersichtliche Komposition.'},
];
export const photoError=(message,status=400)=>Object.assign(new Error(message),{status});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const photoHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function fields(value,allowed,label) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw photoError(`${label}: ungültige oder unbekannte Felder.`);
}
function text(value,max,label,required=false) {
  if(value===undefined&&!required)return '';
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw photoError(`${label} ist ungültig oder zu lang.`);
  return value.replace(/[\u0000-\u001f]/g,' ').trim();
}
export function photoTime(at,duration) {
  if(typeof at!=='number'||!Number.isFinite(at)||at<0||at>Math.max(0,duration-0.001))throw photoError('Die Foto-Zeitmarke liegt außerhalb der Aufnahme.');
  return Math.round(at*1e6)/1e6;
}
export function photoOptions(raw,library,config) {
  fields(raw,['requestId','assetIds','title','subjectReference','subjectDescription','presetId','style','profileContext','format','maxFavorites'],'Foto-Auftrag');
  if(!validId(raw.requestId))throw photoError('Eine gültige Auftragsreferenz ist erforderlich.');
  const ids=raw.assetIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>config.maxFiles||new Set(ids).size!==ids.length)throw photoError(`Eine bis ${config.maxFiles} unterschiedliche Aufnahmen auswählen.`);
  const clips=ids.map(id=>{const clip=validId(id)&&library.get(id);if(!clip||clip.archived||!clip.previewReady||!clip.duration)throw photoError('Eine ausgewählte Aufnahme ist noch nicht verfügbar. Bitte die Vorbereitung abwarten.');return clip;});
  fields(raw.subjectReference,['assetId','at'],'Referenzbild');
  const subject=clips.find(clip=>clip.id===raw.subjectReference.assetId);
  if(!subject)throw photoError('Das Referenzbild muss aus deiner Foto-Auswahl stammen.');
  const preset=photoPresets.find(item=>item.id===(raw.presetId||'presence'));
  if(!preset)throw photoError('Unbekannte gewünschte Wirkung.');
  const maxFavorites=raw.maxFavorites??12;
  if(!Number.isInteger(maxFavorites)||maxFavorites<1||maxFavorites>photoLimits.maxFavorites)throw photoError('Bis zu 1 bis 24 Favoriten pro Runde wählen.');
  if(raw.format!==undefined&&!['both','story','post'].includes(raw.format))throw photoError('Ungültiger Foto-Einsatz.');
  return {assetIds:ids,options:{title:text(raw.title,100,'Sessionname')||'Fotos aus Videos',
    subjectReference:{assetId:subject.id,at:photoTime(raw.subjectReference.at,subject.duration)},
    subjectDescription:text(raw.subjectDescription,500,'Hinweis zur Hauptperson'),
    presetId:preset.id,presetVersion:preset.version,presetStyle:preset.style,
    style:text(raw.style,700,'Eigene Wirkung'),profileContext:text(raw.profileContext,1000,'Profilkontext'),
    format:raw.format||'both',maxFavorites}};
}
export function photoWindow(raw,asset) {
  fields(raw,['assetId','from','to','step'],'Detailfenster');
  if(raw.assetId!==asset.id)throw photoError('Unbekannte Fotoquelle.');
  const from=photoTime(raw.from,asset.duration),to=photoTime(raw.to,asset.duration),step=raw.step;
  if(to<from||to-from>photoLimits.windowSeconds||typeof step!=='number'||!Number.isFinite(step)||step<0.015||step>2)throw photoError('Detailfenster: maximal 30 Sekunden, Abstand 0,015 bis 2 Sekunden.');
  const count=Math.floor((to-from)/step+1e-7)+1;
  if(count>photoLimits.windowFrames)throw photoError(`Maximal ${photoLimits.windowFrames} Bilder pro Detailfenster. Kürzere Zeitfenster wählen.`);
  return {assetId:asset.id,from,to,step:Math.round(step*1e6)/1e6,times:Array.from({length:count},(_,i)=>Math.round((from+i*step)*1e6)/1e6)};
}
function evidenceFrame(raw,session) {
  const asset=session.assets.find(item=>item.id===raw.assetId);
  if(!asset)throw photoError('Das Foto verweist auf eine fremde Aufnahme.');
  const at=photoTime(raw.at,asset.duration);
  const matches=Object.values(session.evidence[asset.id]?.frames||{}).filter(frame=>Math.abs(frame.at-at)<0.00051||Math.abs(frame.requestedAt-at)<0.00051);
  const frame=matches.find(item=>!raw.frameId||item.id===raw.frameId);
  if(!frame)throw photoError('Dieses Bild wurde noch nicht vorbereitet. Erst ein Detailfenster anfordern und ansehen.');
  return {asset,frame};
}
export function validatePhotoReview(raw,session) {
  fields(raw,['summary','subjectStatus','sourceReviews','reviewedWindowIds','candidates','rejections','limitations'],'Foto-Ergebnis');
  if(!['confirmed','unclear'].includes(raw.subjectStatus))throw photoError('Die Hauptperson muss bestätigt oder als unklar markiert werden.');
  if(!Array.isArray(raw.sourceReviews)||raw.sourceReviews.length!==session.assets.length)throw photoError('Für jede Fotoquelle ist ein Sichtungsbefund erforderlich.');
  const seen=new Set();
  const sourceReviews=raw.sourceReviews.map(item=>{
    fields(item,['assetId','decision','reason'],'Sichtungsbefund');
    if(!session.assetIds.includes(item.assetId)||seen.has(item.assetId)||!['reviewed','unsuitable','subject-unclear','unavailable'].includes(item.decision))throw photoError('Unbekannter oder doppelter Sichtungsbefund.');
    seen.add(item.assetId);return {...item,reason:text(item.reason,700,'Sichtungsgrund',true)};
  });
  if(!Array.isArray(raw.reviewedWindowIds)||new Set(raw.reviewedWindowIds).size!==raw.reviewedWindowIds.length)throw photoError('Gesichtete Detailfenster angeben.');
  for(const id of raw.reviewedWindowIds)if(!session.windows[id]||session.windows[id].status!=='done')throw photoError('Ein genanntes Detailfenster ist noch nicht verfügbar.');
  if(!Array.isArray(raw.candidates)||raw.candidates.length>session.options.maxFavorites*2||!Array.isArray(raw.rejections)||raw.rejections.length>96)throw photoError('Zu viele oder ungültige Foto-Kandidaten.');
  if(raw.subjectStatus==='unclear'&&raw.candidates.length)throw photoError('Bei unklarer Hauptperson keine Fotos als bestätigt auswählen.');
  const known=[...session.candidates,...session.rejectedFrames],ids=new Set(),ranks=new Set(),favoriteGroups=new Set(session.candidates.filter(item=>item.favorite&&!item.rejected).map(item=>item.group));
  let favorites=0;
  const candidates=raw.candidates.map(item=>{
    fields(item,['assetId','at','frameId','rank','group','tier','reason','limitations'],'Foto-Kandidat');
    const {asset,frame}=evidenceFrame(item,session);
    if(!raw.reviewedWindowIds.some(id=>{const window=session.windows[id];return window.assetId===asset.id&&window.frameIds.includes(frame.id)&&window.frameIds.length>=3&&window.step<=Math.max(0.12,1/(asset.fps||25));}))throw photoError('Foto-Kandidaten zuerst mit mindestens drei benachbarten Detailbildern vergleichen.');
    if(ids.has(frame.id)||known.some(previous=>previous.frameId===frame.id||(previous.assetId===item.assetId&&Math.abs(previous.at-frame.at)<0.12)))throw photoError('Dieses Bild oder ein unmittelbarer Nachbar wurde bereits gewählt oder abgelehnt.');
    if(!Number.isInteger(item.rank)||item.rank<1||item.rank>48||ranks.has(item.rank)||!['favorite','variant'].includes(item.tier))throw photoError('Ungültiger oder doppelter Foto-Rang.');
    const group=text(item.group,80,'Motivgruppe',true);
    if(item.tier==='favorite') {if(favoriteGroups.has(group))throw photoError('Pro Motivgruppe nur ein Favorit. Ähnliche Bilder als Variante einordnen.');favoriteGroups.add(group);favorites++;}
    if(!Array.isArray(item.limitations)||item.limitations.length>6)throw photoError('Ungültige Foto-Einschränkungen.');
    ids.add(frame.id);ranks.add(item.rank);
    return {frameId:frame.id,assetId:item.assetId,at:frame.at,rank:item.rank,group,tier:item.tier,
      reason:text(item.reason,700,'Auswahlgrund',true),limitations:item.limitations.map(value=>text(value,300,'Einschränkung',true))};
  });
  if(favorites>session.options.maxFavorites||session.candidates.length+candidates.length>photoLimits.candidates)throw photoError('Die Foto-Obergrenze ist überschritten.');
  const rejections=raw.rejections.map(item=>{
    fields(item,['assetId','at','frameId','group','reason'],'Abgelehntes Bild');
    const {frame}=evidenceFrame(item,session);
    if(session.candidates.some(previous=>previous.frameId===frame.id))throw photoError('Eine bestehende Auswahl darf in einer neuen Runde nicht verworfen werden.');
    if(ids.has(frame.id))throw photoError('Ein Bild kann nicht zugleich gewählt und abgelehnt werden.');ids.add(frame.id);
    return {frameId:frame.id,assetId:item.assetId,at:frame.at,group:text(item.group,80,'Motivgruppe'),reason:text(item.reason,500,'Ablehnungsgrund',true)};
  });
  if(!Array.isArray(raw.limitations)||raw.limitations.length>8)throw photoError('Ungültige Sichtungsgrenzen.');
  return {summary:text(raw.summary,1400,'Foto-Zusammenfassung',true),subjectStatus:raw.subjectStatus,sourceReviews,
    reviewedWindowIds:raw.reviewedWindowIds,candidates:candidates.sort((a,b)=>a.rank-b.rank),rejections,
    limitations:raw.limitations.map(value=>text(value,500,'Sichtungsgrenze',true))};
}
