import { uploadQueue } from './upload-tasks.js';
const el=selector=>document.querySelector(selector);
const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const state={clips:[],categories:[],config:null,selected:new Set(),scope:'all',category:'',current:null,uploadFiles:[],timer:null,loaded:false,signatures:new Map(),deepLink:new URLSearchParams(location.search).get('clip')};
const size=bytes=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GB`:`${(bytes/1024**2).toFixed(1)} MB`;
const time=seconds=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
function notice(message) { el('#toast').textContent=message; el('#toast').hidden=false; setTimeout(()=>{el('#toast').hidden=true;},4200); }
function error(selector,message='') { el(selector).textContent=message; el(selector).hidden=!message; }
async function request(url,options={}) {
  const response=await fetch(url,{...options,headers:{'x-reel-studio':'1',...options.headers}});
  const data=await response.json();
  if(!response.ok) { const problem=new Error(data.error||'Die Anfrage konnte nicht verarbeitet werden.'); problem.status=response.status;
    if(response.status===401&&!el('#login-dialog').open) el('#login-dialog').showModal(); throw problem; }
  return data;
}
async function updateClip(id,changes) {
  const clip=await request(`/api/library/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(changes)});
  state.clips=state.clips.map(existing=>existing.id===id?clip:existing); render(); return clip;
}

function view(name) {
  if(!['library','reels','photos','review','learn'].includes(name))name='library';
  const library=name==='library',photos=name==='photos',content=['review','learn'].includes(name); el('#library-view').hidden=!library; el('#reels-view').hidden=name!=='reels';el('#photos-view').hidden=!photos;
  el('#review-view').hidden=name!=='review';el('#learn-view').hidden=name!=='learn';el('#content-controls').hidden=!content;
  el('#view-library').setAttribute('aria-pressed',String(library)); el('#view-reels').setAttribute('aria-pressed',String(name==='reels'));el('#view-photos').setAttribute('aria-pressed',String(photos));
  el('#view-review').setAttribute('aria-pressed',String(name==='review'));el('#view-learn').setAttribute('aria-pressed',String(name==='learn'));
  el('#page-title').innerHTML=library?'Deine Aufnahmen.<br><span>Alles griffbereit.</span>':photos?'Eure Momente.<br><span>Als starke Fotos.</span>':name==='review'?'Dein Geschmack.<br><span>Die passende Version.</span>':name==='learn'?'Aus jedem Versuch.<br><span>Etwas mitnehmen.</span>':'Deine Session.<br><span>Das nächste Reel.</span>';
  el('.intro-copy').innerHTML=library?'Eure Momente sammeln und wiederfinden.<br> Originale für eure nächsten Reels und Fotos.':photos?'Gute Blicke. Klare Haltung.<br>Die besten Einzelbilder aus euren Videos.':content?'Dein Review. Tatsächliche Ergebnisse.<br>Neue Ideen aus eurem vorhandenen Footage.':'Aufnahmen rein. Kontext dazu.<br> Fertige Reels zum Anschauen und Posten.';
  const url=new URL(location.href); url.searchParams.set('view',name); history.replaceState(null,'',url);
  document.dispatchEvent(new CustomEvent('studio-view-changed',{detail:name}));
}
el('#view-library').addEventListener('click',()=>view('library'));
el('#view-reels').addEventListener('click',()=>view('reels'));
el('#view-photos').addEventListener('click',()=>view('photos'));
el('#view-review').addEventListener('click',()=>view('review'));
el('#view-learn').addEventListener('click',()=>view('learn'));
document.addEventListener('studio-view',event=>view(event.detail));
view(new URLSearchParams(location.search).get('view') || 'library');

function basis(clip) { return clip.analysisStatus==='waiting-codex'?'Wartet auf Codex':clip.categoryManual?'Thema manuell':clip.classificationSource==='codex'?'Von Codex ausgewertet':clip.classificationSource==='ai'?'KI einsortiert':'Dateiname / Kontext'; }
function categoryName(id) { return state.categories.find(item=>item.id===id)?.label || 'Unsortiert'; }
function markup(selector,value) {const node=el(selector);if(node.dataset.markup!==value){node.innerHTML=value;node.dataset.markup=value;}}
function filtered() {
  const query=el('#library-search').value.trim().toLocaleLowerCase('de-DE'),collection=el('#library-collection').value;
  let clips=state.clips.filter(clip=>(state.scope==='archive'?clip.archived:!clip.archived)
    &&(state.scope!=='favorites'||clip.favorite)&&(!state.category||clip.category===state.category)
    &&(!collection||clip.collections.includes(collection))
    &&(!query||[clip.title,clip.name,clip.reference,clip.description,clip.note,clip.recordedAt,clip.createdAt,...clip.tags,...clip.collections,...(clip.moments||[]).map(moment=>moment.label+' '+moment.description)].join(' ').toLocaleLowerCase('de-DE').includes(query)));
  const sort=el('#library-sort').value;
  return clips.sort(sort==='name'?(a,b)=>a.title.localeCompare(b.title,'de'):sort==='oldest'?(a,b)=>a.createdAt.localeCompare(b.createdAt):(a,b)=>b.createdAt.localeCompare(a.createdAt));
}
function renderFilters() {
  const active=state.clips.filter(clip=>!clip.archived);
  el('#library-nav-count').textContent=active.length;
  markup('#library-scopes',[['all','Alle Aufnahmen',active.length],['favorites','Favoriten',active.filter(clip=>clip.favorite).length],['archive','Archiv',state.clips.filter(clip=>clip.archived).length]]
    .map(([key,label,count])=>`<button type="button" data-scope="${key}" aria-pressed="${state.scope===key&&!state.category}"><span>${label}</span><small>${count}</small></button>`).join(''));
  markup('#library-categories',state.categories.map(category=>`<button type="button" data-category="${category.id}" aria-pressed="${state.category===category.id}"><span>${html(category.label)}</span><small>${active.filter(clip=>clip.category===category.id).length}</small></button>`).join(''));
  const collection=el('#library-collection'),selected=collection.value;
  const names=[...new Set(state.clips.filter(clip=>!clip.archived || state.scope==='archive').flatMap(clip=>clip.collections))].sort((a,b)=>a.localeCompare(b,'de'));
  const signature=JSON.stringify(names);
  if(collection.dataset.signature!==signature) {
    collection.innerHTML='<option value="">Alle Sammlungen</option>'+names.map(name=>`<option value="${html(name)}">${html(name)}</option>`).join('');
    collection.value=names.includes(selected)?selected:''; collection.dataset.signature=signature;
  }
  const editCategory=el('#clip-edit-category');
  if(!editCategory.options.length) editCategory.innerHTML=state.categories.map(category=>`<option value="${category.id}">${html(category.label)}</option>`).join('');
}
function selection() {
  const valid=new Set(state.clips.filter(clip=>!clip.archived&&clip.status==='ready').map(clip=>clip.id));
  for(const id of state.selected) if(!valid.has(id)) state.selected.delete(id);
  el('#library-selection').hidden=!state.selected.size;
  el('#library-selected-count').textContent=`${state.selected.size} ${state.selected.size===1?'Aufnahme':'Aufnahmen'} ausgewählt`;
  for(const checkbox of document.querySelectorAll('.clip-select-checkbox')) checkbox.checked=state.selected.has(checkbox.dataset.id);
}
function card(clip) {
  const busy=['queued','processing'].includes(clip.status),ready=clip.status==='ready'&&!clip.archived;
  return `<div class="clip-cover"><button type="button" class="clip-open" data-id="${clip.id}" aria-label="${html(clip.title)} ansehen">${clip.posterUrl?`<img src="${clip.posterUrl}" alt="" loading="lazy">`:'<span class="clip-placeholder">Vorschau wird vorbereitet</span>'}<span class="clip-duration">${clip.duration?time(clip.duration):'…'}</span>${clip.width?`<span class="clip-format">${clip.width<clip.height?'HOCH':'QUER'}</span>`:''}<span class="clip-play" aria-hidden="true">▷</span></button><label class="clip-select-label"><input class="clip-select-checkbox" type="checkbox" data-id="${clip.id}" ${ready?'':'disabled'} ${state.selected.has(clip.id)?'checked':''} aria-label="${html(clip.title)} für Reels und Fotos auswählen"></label><button type="button" class="clip-star ${clip.favorite?'active':''}" data-favorite="${clip.id}" aria-label="${html(clip.title)} ${clip.favorite?'aus Favoriten entfernen':'als Favorit markieren'}">${clip.favorite?'★':'☆'}</button></div><div class="clip-card-body"><div class="clip-card-heading"><h3><button type="button" class="clip-open" data-id="${clip.id}">${html(clip.title)}</button></h3><span class="clip-category">${html(categoryName(clip.category))}</span></div><p class="clip-filename" title="${html(clip.name)}">${html(clip.name)}</p><div class="clip-tags">${clip.tags.slice(0,3).map(tag=>`<span>${html(tag)}</span>`).join('')}</div><p class="clip-collection">${html(clip.collections.join(' · '))}</p><p class="clip-card-meta">${size(clip.size)} <span>·</span> ${clip.recordedAt?`Aufnahme ${html(clip.recordedAt)}`:`Upload ${new Date(clip.createdAt).toLocaleDateString('de-DE')}`}</p><p class="classification-basis ${['ai','codex'].includes(clip.classificationSource)?'ai':''}">${busy?'Wird vorbereitet …':clip.status==='error'?'Vorbereitung prüfen':basis(clip)}</p><div class="clip-card-actions"><button type="button" class="clip-open" data-id="${clip.id}">Ansehen & einordnen</button><a href="${clip.originalUrl}?download=1">Original ↓</a></div></div>`;
}
function render() {
  renderFilters(); selection();
  const clips=filtered(),ids=new Set(clips.map(clip=>clip.id)),grid=el('#library-grid');
  for(const element of [...grid.children]) if(!ids.has(element.dataset.id)) {state.signatures.delete(element.dataset.id);element.remove();}
  clips.forEach((clip,index)=>{
    let element=grid.querySelector(`[data-id="${clip.id}"]`); const signature=JSON.stringify(clip);
    if(!element) {element=document.createElement('article');element.className='clip-card';element.dataset.id=clip.id;}
    if(state.signatures.get(clip.id)!==signature) {element.innerHTML=card(clip);state.signatures.set(clip.id,signature);}
    if(grid.children[index]!==element) grid.insertBefore(element,grid.children[index]||null);
  });
  selection();
  el('#library-summary').textContent=`${clips.length} ${clips.length===1?'Aufnahme':'Aufnahmen'}${state.clips.some(clip=>['queued','processing'].includes(clip.status))?' · Vorschauen werden vorbereitet':''}`;
  el('#library-empty').hidden=Boolean(clips.length)||!state.loaded;
  el('#library-empty h3').textContent=state.clips.length?'Keine Aufnahme passt zu deiner Auswahl.':'Hier sammeln sich eure Momente.';
  el('#library-empty p').innerHTML=state.clips.length?'Ändere die Suche, das Thema oder die Sammlung.':'Lege eure ersten Billard-, Sport- oder Event-Aufnahmen ab.<br>Du kannst sie später für mehrere Reels verwenden.';
  const codex=state.config?.analysisProvider==='codex';
  const note=codex?'Codex wertet neue Aufnahmen aus und ergänzt Verwendung, Fundstellen und Reel-Ideen.':state.config?.analysisReady?'Neue Aufnahmen werden automatisch inhaltlich einsortiert.':'Ohne Videoanalyse: Einordnung nach Dateiname und Kontext. Inhalte lassen sich mit KI ergänzen.';
  el('#library-analyze-all').textContent=codex?'Offene von Codex auswerten':'Offene mit KI einsortieren';
  el('#library-analysis-note').textContent=note;
  el('#library-upload-analysis').textContent=codex?'Nach dem Upload erstellt dein Server Bildfolgen und ein lokales Sprachtranskript. Die Codex-Automation in deinem Chat übernimmt die Auswertung, sobald dein Rechner mit Codex läuft. Kein separater Anbieter-Schlüssel erforderlich.':state.config?.analysisReady?'Nach dem Upload werden komprimierte Vorschauen automatisch an Google zur Inhaltssortierung übertragen. Die API-Nutzung läuft über dein Google-Konto.':'Die Aufnahme wird gespeichert, eine Vorschau erzeugt und nach Dateiname und deinem Kontext eingeordnet. Für eine Einordnung anhand des Videoinhalts kannst du später die Videoanalyse verbinden.';
  if(state.current&&el('#clip-dialog').open) updateDetail(state.clips.find(clip=>clip.id===state.current));
}
async function refresh() {
  clearTimeout(state.timer);
  try {
    const data=await request('/api/library'); state.clips=data.clips;state.categories=data.categories;state.loaded=true;
    state.config={...state.config,analysisReady:data.analysisReady,analysisProvider:data.analysisProvider,brain:data.brain};
    document.dispatchEvent(new CustomEvent('studio-brain',{detail:data.brain}));
    el('#library-storage').textContent=`${size(data.storage.usedBytes)} Originale · ${size(data.storage.availableBytes)} frei für Uploads`;
    el('#library-storage-bar').value=(data.storage.totalBytes-data.storage.freeBytes)/data.storage.totalBytes*100;
    el('#library-storage-volume').textContent=`Volume ${size(data.storage.totalBytes)} · ${size(data.storage.reserveBytes)} für Vorschauen und Exporte reserviert.`;
    error('#library-error'); render();
    if(state.deepLink) {const id=state.deepLink;state.deepLink=null;if(state.clips.some(clip=>clip.id===id))openClip(id);}
  } catch(problem) {if(problem.status!==401) error('#library-error',problem.message);}
  finally {state.timer=setTimeout(refresh,document.hidden?10_000:4000);}
}
document.addEventListener('studio-config',event=>{state.config=event.detail;refresh();});
document.addEventListener('studio-upload-saved',()=>refresh());
document.addEventListener('studio-upload-complete',()=>refresh());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
for(const id of ['#library-search','#library-collection','#library-sort']) el(id).addEventListener(id==='#library-search'?'input':'change',render);
el('.library-sidebar').addEventListener('click',event=>{
  const scope=event.target.closest('[data-scope]'),category=event.target.closest('[data-category]');
  if(scope) {state.scope=scope.dataset.scope;state.category='';}
  if(category) {state.scope='all';state.category=state.category===category.dataset.category?'':category.dataset.category;}
  render();
});
el('#library-grid').addEventListener('change',event=>{
  if(!event.target.matches('.clip-select-checkbox'))return;
  const id=event.target.dataset.id;
  if(event.target.checked&&state.selected.size>=(state.config?.maxFiles||30)) {event.target.checked=false;notice(`Maximal ${state.config?.maxFiles||30} Aufnahmen für einen Reel-Auftrag.`);return;}
  event.target.checked?state.selected.add(id):state.selected.delete(id);selection();
});
el('#library-grid').addEventListener('click',async event=>{
  const open=event.target.closest('.clip-open'),favorite=event.target.closest('[data-favorite]');
  if(open)openClip(open.dataset.id);
  if(favorite) {const clip=state.clips.find(item=>item.id===favorite.dataset.favorite);try{await updateClip(clip.id,{favorite:!clip.favorite});}catch(problem){notice(problem.message);}}
});
el('#library-selection-clear').addEventListener('click',()=>{state.selected.clear();selection();});
el('#library-use-selected').addEventListener('click',()=>{
  const clips=state.clips.filter(clip=>state.selected.has(clip.id));
  if(clips.length) document.dispatchEvent(new CustomEvent('library-selection',{detail:clips}));
});
el('#library-photos-selected').addEventListener('click',()=>{
  const clips=state.clips.filter(clip=>state.selected.has(clip.id));
  if(clips.length)document.dispatchEvent(new CustomEvent('library-photo-selection',{detail:clips}));
});
el('#library-analyze-all').addEventListener('click',async()=>{
  if(!state.config?.analysisReady) {el('#settings-dialog').showModal();return;}
  const button=el('#library-analyze-all');button.disabled=true;
  try {const result=await request('/api/library/analyze',{method:'POST'});notice(result.queued?`${result.queued} Aufnahmen ${state.config?.analysisProvider==='codex'?'warten auf Codex':'werden mit KI einsortiert'}.`:'Alle verfügbaren Aufnahmen sind bereits einsortiert.');await refresh();}
  catch(problem){notice(problem.message);}finally{button.disabled=false;}
});

function updateDetail(clip) {
  if(!clip)return;
  el('#clip-title').textContent=clip.title;
  el('#clip-info').textContent=`${clip.name} · ${clip.duration?time(clip.duration):'noch nicht vorbereitet'} · ${clip.width?`${clip.width} × ${clip.height} · `:''}${size(clip.size)}`;
  el('#clip-download').href=clip.originalUrl+'?download=1';
  el('#clip-description').textContent=clip.description||'Die inhaltliche Beschreibung ist noch offen. Du kannst eine eigene Notiz ergänzen oder die Aufnahme mit KI einsortieren.';
  el('#clip-analysis-status').textContent=['queued','processing'].includes(clip.status)?clip.stage:clip.analysisError||`${basis(clip)}${clip.providerCleanupWarning?' · Die Löschung einer temporären Anbieterdatei wurde nicht bestätigt.':''}`;
  el('#clip-reference').textContent=clip.reference;
  el('#clip-favorite').textContent=clip.favorite?'Favorit entfernen':'Favorit markieren';
  el('#clip-archive').textContent=clip.archived?'Aus Archiv zurückholen':'Archivieren';
  el('#clip-select').textContent=state.selected.has(clip.id)?'Aus Reel-Auswahl entfernen':'Für Reel auswählen';
  el('#clip-select').disabled=clip.status!=='ready'||clip.archived;
  el('#clip-analyze').disabled=['queued','processing'].includes(clip.status)||clip.analysisStatus==='waiting-codex';
  el('#clip-analyze').textContent=!clip.previewReady?'Vorschau erneut vorbereiten':clip.analysisStatus==='waiting-codex'?'Wartet auf Codex':state.config?.analysisProvider==='codex'?'Von Codex auswerten':state.config?.analysisReady?'Mit KI einsortieren':'Videoanalyse verbinden';
  const review=clip.brainReview;
  const labels={strong:'Als Reel geeignet',supporting:'Als ergänzende Szene nutzen','needs-context':'Kontext oder weitere Aufnahme nötig',unsuitable:'Für HEC-Reels nicht geeignet'};
  markup('#clip-brain-review',review?`<h3>Codex-Auswertung</h3><p class="review-use">${html(labels[review.assessment.use])}</p><p>${html(review.assessment.reason)}</p><p><strong>Nächster Schritt:</strong> ${html(review.assessment.nextStep)}</p>${review.ideas.length?'<h3>Reel-Ideen</h3>'+review.ideas.map(idea=>`<article><h4>${html(idea.title)}</h4><p class="review-hook">${html(idea.hook)}</p><p>${html(idea.angle)}</p>${idea.needs?`<p class="fine-print">Noch nötig: ${html(idea.needs)}</p>`:''}</article>`).join(''):''}${review.limitations.length?'<p class="fine-print">'+review.limitations.map(html).join(' · ')+'</p>':''}`:'');
  el('#clip-brain-review').hidden=!review;
  const player=el('#clip-player');
  if(player.dataset.clip!==clip.id || player.dataset.source!==(clip.previewUrl||'')) {
    player.pause(); if(clip.previewUrl)player.src=clip.previewUrl;else player.removeAttribute('src');
    if(clip.posterUrl)player.poster=clip.posterUrl;else player.removeAttribute('poster');
    player.dataset.clip=clip.id;player.dataset.source=clip.previewUrl||'';player.load();
  }
  el('#clip-moments').innerHTML=clip.moments?.length?'<h3>Fundstellen im Video</h3>'+clip.moments.map(moment=>`<button type="button" data-from="${moment.from}"><time>${time(moment.from)}</time><span><strong>${html(moment.label)}</strong><small>${html(moment.description)}</small></span><span aria-hidden="true">↗</span></button>`).join(''):'';
}
function openClip(id) {
  const clip=state.clips.find(item=>item.id===id);if(!clip)return;
  state.current=id;updateDetail(clip);error('#clip-error');
  el('#clip-edit-title').value=clip.title;el('#clip-edit-category').value=clip.category;el('#clip-edit-tags').value=clip.tags.join(', ');
  el('#clip-edit-collections').value=clip.collections.join(', ');el('#clip-edit-date').value=clip.recordedAt||'';el('#clip-edit-note').value=clip.note||'';
  el('#clip-dialog').showModal();
  const mark=new URLSearchParams(location.search).get('at');
  if(mark!==null&&Number.isFinite(Number(mark))) {
    const player=el('#clip-player'),seek=()=>{player.currentTime=Math.min(Math.max(0,Number(mark)),Math.max(0,player.duration-0.08));};
    if(player.readyState>=1)seek();else player.addEventListener('loadedmetadata',seek,{once:true});
  }
}
el('#clip-close').addEventListener('click',()=>el('#clip-dialog').close());
el('#clip-dialog').addEventListener('close',()=>{el('#clip-player').pause();state.current=null;});
el('#clip-copy-reference').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(el('#clip-reference').textContent);notice('Footage-Referenz kopiert.');}catch{notice('Die Referenz steht direkt neben dem Button.');}});
el('#clip-select').addEventListener('click',()=>{
  if(state.selected.has(state.current))state.selected.delete(state.current);
  else if(state.selected.size<(state.config?.maxFiles||30))state.selected.add(state.current);else return notice(`Maximal ${state.config?.maxFiles||30} Aufnahmen pro Reel-Auftrag.`);
  render();
});
el('#clip-favorite').addEventListener('click',async()=>{try{const clip=state.clips.find(item=>item.id===state.current);await updateClip(clip.id,{favorite:!clip.favorite});}catch(problem){error('#clip-error',problem.message);}});
el('#clip-archive').addEventListener('click',async()=>{try{const clip=state.clips.find(item=>item.id===state.current);await updateClip(clip.id,{archived:!clip.archived});notice(clip.archived?'Aufnahme zurückgeholt.':'Aufnahme archiviert. Das Original bleibt erhalten.');}catch(problem){error('#clip-error',problem.message);}});
el('#clip-analyze').addEventListener('click',async()=>{
  const clip=state.clips.find(item=>item.id===state.current);
  if(clip.previewReady&&!state.config?.analysisReady){el('#clip-dialog').close();el('#settings-dialog').showModal();return;}
  try{await request(`/api/library/${clip.id}/analyze`,{method:'POST'});await refresh();}catch(problem){error('#clip-error',problem.message);}
});
el('#clip-moments').addEventListener('click',event=>{const button=event.target.closest('[data-from]');if(button){el('#clip-player').currentTime=Number(button.dataset.from);el('#clip-player').play().catch(()=>{});}});
el('#clip-edit-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('[type="submit"]');button.disabled=true;error('#clip-error');
  try{await updateClip(state.current,{title:el('#clip-edit-title').value,category:el('#clip-edit-category').value,
    tags:el('#clip-edit-tags').value.split(',').map(value=>value.trim()).filter(Boolean),collections:el('#clip-edit-collections').value.split(',').map(value=>value.trim()).filter(Boolean),
    recordedAt:el('#clip-edit-date').value,note:el('#clip-edit-note').value});notice('Einordnung gespeichert.');}
  catch(problem){error('#clip-error',problem.message);}finally{button.disabled=false;}
});

el('#library-upload-open').addEventListener('click',()=>{error('#library-upload-error');el('#library-upload-dialog').showModal();});
el('#library-upload-close').addEventListener('click',()=>el('#library-upload-dialog').close());
function renderUploads() {
  el('#library-upload-summary').textContent=state.uploadFiles.length?`${state.uploadFiles.length} ${state.uploadFiles.length===1?'Datei':'Dateien'} · ${size(state.uploadFiles.reduce((sum,file)=>sum+file.size,0))} · ${state.uploadFiles.length===1?'wird':'werden'} einzeln hochgeladen`:'Viele Dateien oder einen ganzen Ordner auswählen. Der Upload startet nach Klick auf „In Bibliothek ablegen“.';
  el('#library-upload-files').innerHTML=state.uploadFiles.map((file,index)=>`<div class="file-chip upload-file"><span class="upload-file-name" title="${html(file.name)}">${html(file.name)}</span><span class="size">${size(file.size)}</span><span class="upload-file-status">Bereit</span><button type="button" data-upload-remove="${index}" aria-label="${html(file.name)} aus Auswahl entfernen">×</button></div>`).join('');
}
function addUploads(selected) {
  for(const file of selected) if(/\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(file.name)&&!state.uploadFiles.some(existing=>existing.name===file.name&&existing.size===file.size&&existing.lastModified===file.lastModified))state.uploadFiles.push(file);
  renderUploads();error('#library-upload-error');
}
for(const id of ['#library-videos','#library-folder'])el(id).addEventListener('change',event=>{addUploads([...event.target.files]);event.target.value='';});
el('#library-folder-open').addEventListener('click',()=>el('#library-folder').click());
el('#library-upload-files').addEventListener('click',event=>{const button=event.target.closest('[data-upload-remove]');if(button){state.uploadFiles.splice(Number(button.dataset.uploadRemove),1);renderUploads();}});
el('#library-upload-form').addEventListener('dragover',event=>{event.preventDefault();});
el('#library-upload-form').addEventListener('drop',event=>{event.preventDefault();addUploads([...event.dataTransfer.files]);});
el('#library-upload-form').addEventListener('submit',event=>{
  event.preventDefault();error('#library-upload-error');
  const files=[...state.uploadFiles];
  if(!files.length)return error('#library-upload-error','Wähle zuerst Videoaufnahmen aus.');
  const fields=Object.fromEntries(new FormData(event.target));delete fields['videos'];
  try{
    uploadQueue.enqueue({files,fields,kind:'library',label:fields.collection?.trim()||`${files.length} ${files.length===1?'Aufnahme':'Aufnahmen'} ablegen`});
    event.target.reset();state.uploadFiles=[];renderUploads();el('#library-upload-dialog').close();
    notice('Upload läuft im Hintergrund. Du kannst die Studio-Ansicht wechseln.');
  }catch(problem){error('#library-upload-error',problem.message);}
});
renderUploads();refresh();
