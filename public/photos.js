const $=selector=>document.querySelector(selector);
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={sessions:[],current:new URLSearchParams(location.search).get('photo'),clips:[],reference:null,config:null,filter:'favorites',timer:null,busy:false};
const labels={queued:'Wird vorbereitet',preparing:'Wird gesichtet','waiting-codex':'Wartet auf Codex','export-queued':'Export wartet',exporting:'Fotos werden exportiert',ready:'Auswahl bereit',empty:'Keine weiteren Fotos','needs-subject':'Hauptperson klären',error:'Verarbeitung prüfen',cancelled:'Abgebrochen'};
const active=session=>['queued','preparing','waiting-codex','export-queued','exporting'].includes(session.status);
const clock=at=>`${Math.floor(at/60)}:${(at%60).toFixed(3).padStart(6,'0')}`;
function notice(message){$('#toast').textContent=message;$('#toast').hidden=false;setTimeout(()=>$('#toast').hidden=true,5000);}
function error(selector,message=''){$(selector).textContent=message;$(selector).hidden=!message;}
async function request(url,options={}) {
  const response=await fetch(url,{...options,headers:{'x-reel-studio':'1',...options.headers}});let data;
  try{data=await response.json();}catch{throw new Error('Die Bestätigung ist unklar. Den gleichen Auftrag erneut prüfen.');}
  if(!response.ok){const problem=new Error(data.error||'Die Anfrage ist fehlgeschlagen.');problem.status=response.status;if(response.status===401&&!$('#login-dialog').open)$('#login-dialog').showModal();throw problem;}
  return data;
}
async function confirmed(url,payload,key,method='POST') {
  const storageKey=`hec-photo-pending:${key}`;let saved;
  try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
  const operation=saved||{url,method,payload:{...payload,requestId:crypto.randomUUID()}};
  sessionStorage.setItem(storageKey,JSON.stringify(operation));
  try {
    const result=await request(operation.url,{method:operation.method,headers:{'Content-Type':'application/json'},body:JSON.stringify(operation.payload)});
    sessionStorage.removeItem(storageKey);return result;
  }catch(problem){if(problem.status&&problem.status<500&&![408,429].includes(problem.status))sessionStorage.removeItem(storageKey);throw problem;}
}
function chooseSession(id){state.current=id;const url=new URL(location.href);url.searchParams.set('photo',id);history.replaceState(null,'',url);render();}
function presetDescription(){const preset=state.config?.presets.find(item=>item.id===$('#photo-preset').value);$('#photo-preset-description').textContent=preset?.style||'Souverän, tatkräftig und präsent.';}
function openForm(clips,options=null) {
  state.clips=clips;state.reference=null;$('#photo-create-form').reset();error('#photo-create-error');$('#photo-reference-chosen').hidden=true;
  $('#photo-source-count').textContent=`${clips.length} ${clips.length===1?'Originalaufnahme':'Originalaufnahmen'} aus deiner Bibliothek. Ein weiterer Upload ist nicht nötig.`;
  $('#photo-reference-source').innerHTML=clips.map(clip=>`<option value="${clip.id}">${html(clip.title||clip.name)}</option>`).join('');
  if(options){for(const key of ['title','subjectDescription','presetId','style','profileContext','maxFavorites','format'])if($('#photo-create-form').elements[key])$('#photo-create-form').elements[key].value=options[key];$('#photo-reference-source').value=options.subjectReference.assetId;}
  changeSource();presetDescription();document.dispatchEvent(new CustomEvent('studio-view',{detail:'photos'}));$('#photo-create-dialog').showModal();
}
function changeSource() {
  const clip=state.clips.find(item=>item.id===$('#photo-reference-source').value);if(!clip)return;
  state.reference=null;$('#photo-reference-chosen').hidden=true;
  const player=$('#photo-reference-video');player.src=clip.previewUrl||`/api/library/${clip.id}/files/preview`;player.poster=clip.posterUrl||'';player.load();
  $('#photo-reference-time').value=0;$('#photo-reference-time').max=Math.max(0,(clip.duration||1)-0.08);
}
document.addEventListener('library-photo-selection',event=>openForm(event.detail));
document.addEventListener('studio-config',()=>{loadConfig();refresh();});
document.addEventListener('studio-view-changed',event=>{if(event.detail==='photos')refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
$('#photos-select-library').addEventListener('click',()=>document.dispatchEvent(new CustomEvent('studio-view',{detail:'library'})));
$('#photo-create-close').addEventListener('click',()=>$('#photo-create-dialog').close());
$('#photo-create-dialog').addEventListener('close',()=>$('#photo-reference-video').pause());
$('#photo-reference-source').addEventListener('change',changeSource);
$('#photo-preset').addEventListener('change',presetDescription);
$('#photo-reference-video').addEventListener('loadedmetadata',()=>{$('#photo-reference-time').max=Math.max(0,$('#photo-reference-video').duration-0.08);});
$('#photo-reference-video').addEventListener('timeupdate',()=>{$('#photo-reference-time').value=$('#photo-reference-video').currentTime;});
$('#photo-reference-time').addEventListener('input',()=>{const player=$('#photo-reference-video');player.pause();player.currentTime=Number($('#photo-reference-time').value);});
$('#photo-reference-use').addEventListener('click',()=>{
  const player=$('#photo-reference-video');if(player.readyState<2)return error('#photo-create-error','Bitte warten, bis das Bild geladen ist.');
  player.pause();const canvas=$('#photo-reference-canvas');canvas.width=240;canvas.height=Math.round(240*player.videoHeight/player.videoWidth);canvas.getContext('2d').drawImage(player,0,0,canvas.width,canvas.height);
  state.reference={assetId:$('#photo-reference-source').value,at:Math.min(player.currentTime,Math.max(0,player.duration-0.08))};
  $('#photo-reference-chosen').hidden=false;$('#photo-reference-label').textContent=`Gewählte Referenz: ${clock(state.reference.at)}`;error('#photo-create-error');
});
$('#photo-create-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.busy)return;
  const pending=sessionStorage.getItem('hec-photo-pending:create');if(!state.reference&&!pending)return error('#photo-create-error','Wähle zuerst ein deutliches Referenzbild der Hauptperson.');
  state.busy=true;$('#photo-create-submit').disabled=true;error('#photo-create-error');
  try {
    const fields=Object.fromEntries(new FormData(event.currentTarget));fields.maxFavorites=Number(fields.maxFavorites);
    const session=await confirmed('/api/photos/from-library',{...fields,assetIds:state.clips.map(item=>item.id),subjectReference:state.reference},'create');
    $('#photo-create-dialog').close();await refresh();chooseSession(session.id);notice('Foto-Auftrag gespeichert. Die Bilder werden vorbereitet.');
  }catch(problem){error('#photo-create-error',problem.message);}finally{state.busy=false;$('#photo-create-submit').disabled=false;}
});
async function loadConfig(){try{state.config=await request('/api/photos/config');presetDescription();}catch(problem){if(problem.status!==401)error('#photos-error',problem.message);}}
async function refresh() {
  clearTimeout(state.timer);
  try {const data=await request('/api/photos');state.sessions=data.sessions;document.dispatchEvent(new CustomEvent('studio-brain',{detail:data.brain}));error('#photos-error');render();}
  catch(problem){if(problem.status!==401)error('#photos-error',problem.message);}
  finally{state.timer=setTimeout(refresh,document.hidden?12_000:5000);}
}
function candidateCard(item) {
  return `<article class="photo-card ${item.rejected?'photo-rejected':''}"><button type="button" class="photo-open" data-frame="${item.frameId}" aria-label="Foto bei ${clock(item.at)} groß ansehen"><img src="${item.imageUrl||item.previewUrl}" alt="${html(item.reason)}" loading="lazy"><span class="photo-rank">${item.favorite?'★ FAVORIT':'VARIANTE'} · ${item.rank}</span></button><div class="photo-card-copy"><p>${html(item.reason)}</p><small>${html(item.group)} · Runde ${item.round}</small><a class="photo-origin" href="${item.sourceUrl}">${html(item.sourceName)} · ${clock(item.at)} ↗</a>${item.output?`<small>${item.output.width} × ${item.output.height} px · Originalexport</small>`:'<small>Originalexport wird vorbereitet</small>'}<div class="photo-card-actions"><button type="button" data-action="${item.favorite?'unfavorite':'favorite'}" data-frame="${item.frameId}">${item.favorite?'★ Favorit':'☆ Favorisieren'}</button><button type="button" data-action="${item.rejected?'restore':'reject'}" data-frame="${item.frameId}">${item.rejected?'Wiederherstellen':'Ablehnen'}</button>${item.imageUrl&&!item.rejected?`<a href="${item.imageUrl}?download=1">JPEG ↓</a>`:''}</div></div></article>`;
}
function render() {
  $('#photos-nav-count').textContent=state.sessions.length;$('#photos-empty').hidden=Boolean(state.sessions.length);$('#photo-workspace').hidden=!state.sessions.length;
  if(!state.sessions.length)return;if(!state.sessions.some(item=>item.id===state.current))state.current=state.sessions[0].id;
  const list=state.sessions.map(item=>`<button type="button" class="photo-session ${item.id===state.current?'active':''}" data-session="${item.id}" aria-pressed="${item.id===state.current}"><strong>${html(item.title)}</strong><span>${labels[item.status]} · Runde ${item.round}</span><small>${new Date(item.createdAt).toLocaleDateString('de-DE')} · ${item.selectedFrameIds.length} Favoriten</small></button>`).join('');
  if($('#photo-sessions').dataset.markup!==list){$('#photo-sessions').innerHTML=list;$('#photo-sessions').dataset.markup=list;}
  const session=state.sessions.find(item=>item.id===state.current),detail=$('#photo-detail'),signature=JSON.stringify([session,state.filter]);if(detail.dataset.signature===signature)return;
  const note=detail.querySelector('#photo-more-note')?.value||'',all=session.candidates.filter(item=>!item.rejected),items=session.candidates.filter(item=>state.filter==='rejected'?item.rejected:!item.rejected&&(state.filter==='favorites'?item.favorite:!item.favorite)).sort((a,b)=>a.round-b.round||a.rank-b.rank);
  const archive=session.exports.find(item=>item.version===session.selectionVersion),canMore=['ready','empty','cancelled'].includes(session.status)&&session.round<5;
  detail.innerHTML=`<header class="photo-detail-heading"><div><p class="eyebrow">FOTO-SESSION / RUNDE ${session.round}</p><h2>${html(session.title)}</h2><p class="photo-stage" role="status">${html(session.stage)}</p></div>${session.referenceUrl?`<img class="photo-subject-reference" src="${session.referenceUrl}" alt="Gewähltes Referenzbild der Hauptperson">`:''}</header><progress max="100" value="${session.progress}" aria-label="Fortschritt der Foto-Session"></progress>${session.status==='waiting-codex'?'<p class="photo-wait-note">Dein Auftrag ist gespeichert und wartet auf die visuelle Auswahl durch Codex. Dafür müssen dein Rechner und Codex laufen.</p>':''}${session.error?`<p class="error-message" role="alert">${html(session.error)}</p>`:''}<p>${html(session.summary)}</p><div class="photo-session-actions">${archive?`<a class="primary-button compact" href="${archive.url}">${archive.count} Favoriten als ZIP ↓</a>`:`<button class="primary-button compact" type="button" data-session-action="export" ${active(session)||!session.selectedFrameIds.length?'disabled':''}>Auswahl-Download aktualisieren</button>`}${active(session)?'<button class="text-button" type="button" data-session-action="cancel">Auftrag abbrechen</button>':''}${['cancelled','error'].includes(session.status)?'<button class="text-button" type="button" data-session-action="retry">Verarbeitung fortsetzen</button>':''}${session.status==='needs-subject'?'<button class="text-button" type="button" data-session-action="reference">Eindeutigere Referenz wählen</button>':''}</div><div class="photo-tabs" role="group" aria-label="Fotoauswahl filtern">${[['favorites','Favoriten',all.filter(item=>item.favorite).length],['variants','Weitere Varianten',all.filter(item=>!item.favorite).length],['rejected','Abgelehnt',session.candidates.filter(item=>item.rejected).length]].map(([id,label,count])=>`<button type="button" data-photo-filter="${id}" aria-pressed="${state.filter===id}">${label} <span>${count}</span></button>`).join('')}</div><div class="photo-grid">${items.map(candidateCard).join('')}</div>${!items.length?`<p class="photo-no-results">${active(session)?'Hier erscheinen die geprüften Bilder, sobald die Auswahl exportiert ist.':'In dieser Ansicht sind keine Fotos ausgewählt.'}</p>`:''}${canMore?'<div class="photo-more-box"><h3>Noch andere Motive finden</h3><p>Vorhandene Favoriten bleiben erhalten. Gewählte und abgelehnte Frames werden bei der nächsten Runde ausgeschlossen.</p><label class="field">Wunsch für die Fortsetzung · optional<textarea id="photo-more-note" maxlength="1000" rows="2" placeholder="Zum Beispiel: mehr klare Blicke, andere Gesten oder weitere Szenen."></textarea></label><button class="secondary-button" type="button" data-session-action="more">Mehr Fotos finden</button></div>':''}<details class="photo-coverage"><summary>Herkunft und tatsächliche Sichtungstiefe</summary><p>Übersichten und Detailfenster sind Stichproben. Der Befund zeigt die vorbereiteten Bilder und die von Codex angegebenen Sichtungen.</p>${session.assets.map(asset=>`<article><strong>${html(asset.name)}</strong><p>${asset.overview.count} Übersichtsbilder · größter Abstand ${asset.overview.maxGapSeconds.toFixed(3)} s ${asset.error?'· '+html(asset.error):''}</p>${asset.windows.map(window=>`<small>${clock(window.from)}–${clock(window.to)} · Abstand ${window.step} s · ${window.frameCount} Bilder · ${html(window.status)}${window.error?' · '+html(window.error):''}</small>`).join('')}${asset.colorWarning?`<p>${html(asset.colorWarning)}</p>`:''}</article>`).join('')}${session.rounds.filter(round=>round.sourceReviews).map(round=>`<h4>Sichtungsbefund Runde ${round.number}</h4>${round.sourceReviews.map(review=>`<p><strong>${html(session.assets.find(asset=>asset.id===review.assetId)?.name)}</strong>: ${html(review.reason)}</p>`).join('')}`).join('')}${session.limitations.length?`<p>${session.limitations.map(html).join(' · ')}</p>`:''}</details>`;
  if(detail.querySelector('#photo-more-note'))detail.querySelector('#photo-more-note').value=note;detail.dataset.signature=signature;
}
$('#photo-sessions').addEventListener('click',event=>{const button=event.target.closest('[data-session]');if(button)chooseSession(button.dataset.session);});
function showImage(frameId) {
  const session=state.sessions.find(item=>item.id===state.current),item=session.candidates.find(item=>item.frameId===frameId);if(!item)return;
  $('#photo-image-heading').textContent=`${item.favorite?'Favorit':'Variante'} · ${clock(item.at)}`;$('#photo-image').src=item.imageUrl||item.previewUrl;$('#photo-image').alt=item.reason;
  $('#photo-image-info').innerHTML=`<p>${html(item.reason)}</p>${item.limitations.length?`<p class="fine-print">${item.limitations.map(html).join(' · ')}</p>`:''}<p class="fine-print">Motivgruppe: ${html(item.group)} · ${item.output?`${item.output.width} × ${item.output.height} px`:'Vorschau'}</p><div class="output-actions"><a href="${item.sourceUrl}">Quelle bei ${clock(item.at)} ansehen ↗</a>${item.imageUrl&&!item.rejected?`<a class="download" href="${item.imageUrl}?download=1">JPEG herunterladen ↓</a>`:''}</div>`;$('#photo-image-dialog').showModal();
}
$('#photo-image-close').addEventListener('click',()=>$('#photo-image-dialog').close());
$('#photo-detail').addEventListener('click',async event=>{
  const filter=event.target.closest('[data-photo-filter]');if(filter){state.filter=filter.dataset.photoFilter;render();return;}
  const open=event.target.closest('.photo-open');if(open){showImage(open.dataset.frame);return;}
  const selection=event.target.closest('[data-action]'),action=event.target.closest('[data-session-action]');if((!selection&&!action)||state.busy)return;
  const session=state.sessions.find(item=>item.id===state.current);state.busy=true;const button=selection||action;button.disabled=true;
  try {
    if(selection)await confirmed(`/api/photos/${session.id}/selection`,{frameId:selection.dataset.frame,action:selection.dataset.action},`selection:${session.id}:${selection.dataset.frame}`,'PATCH');
    else {
      const kind=action.dataset.sessionAction;
      if(kind==='reference'){const clips=await request('/api/library');openForm(clips.clips.filter(item=>session.assets.some(asset=>asset.id===item.id)),session.options);return;}
      if(['more','export'].includes(kind))await confirmed(`/api/photos/${session.id}/${kind}`,kind==='more'?{note:$('#photo-more-note')?.value||''}:{},`${kind}:${session.id}`);
      else await request(`/api/photos/${session.id}/${kind}`,{method:'POST'});
    }
    await refresh();
  }catch(problem){notice(problem.message);}finally{state.busy=false;button.disabled=false;}
});
loadConfig();refresh();
