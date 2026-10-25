import { uploadQueue } from './upload-tasks.js';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
let configuration = null, files = [], pollTimer;
let librarySources = [];
const cardSignatures = new Map();

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'x-reel-studio':'1', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Die Anfrage ist fehlgeschlagen.');
    error.status = response.status;
    if (response.status === 401 && !$('#login-dialog').open) $('#login-dialog').showModal();
    throw error;
  }
  return data;
}

function errorMessage(selector, message) { const element = $(selector); element.textContent = message || ''; element.hidden = !message; }
function toast(message) { const element = $('#toast'); element.textContent = message; element.hidden = false; setTimeout(() => { element.hidden = true; }, 4200); }

async function loadConfiguration() {
  configuration = await api('/api/config');
  const status = $('#connection-status');
  const codex=configuration.analysisProvider==='codex';
  status.textContent = !configuration.engineReady ? 'Schnittdienst prüfen' : codex ? configuration.brain?.online?'Codex verbunden':'Codex wartet auf Verbindung' : configuration.analysisReady ? 'Videoanalyse bereit' : 'Schnitt bereit · Analyse verbinden';
  status.className = `status-pill ${!configuration.engineReady ? 'error' : (codex?configuration.brain?.online:configuration.analysisReady) ? 'ready' : ''}`;
  $('#settings-open').textContent = codex?'Codex-Brain':configuration.analysisReady ? 'Videoanalyse' : 'Videoanalyse verbinden';
  updateBrainDialog();
  $('#logout').hidden = !configuration.authenticated;
  $('#upload-limits').textContent = `Bis zu ${configuration.maxFiles} Clips für diesen Schnitt · ${(configuration.maxFileMB/1024).toFixed(0)} GB pro Datei · viele Dateien in der Bibliothek sammeln`;
  $('#analysis-note').hidden = configuration.analysisReady;
  const styleSelect = $('#reel-style-profile'), selectedStyle = styleSelect.value;
  if (configuration.styleProfiles?.length) {
    styleSelect.innerHTML = configuration.styleProfiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</option>`).join('');
    styleSelect.value = configuration.styleProfiles.some(profile => profile.id === selectedStyle) ? selectedStyle : 'standard';
  }
  updateStyleProfile();
  updateSubmit();
  document.dispatchEvent(new CustomEvent('studio-config',{detail:configuration}));
}

function updateBrainDialog() {
  const brain=configuration?.brain||{};
  $('#brain-status-detail').textContent=brain.lastSeenAt?`Letzter Codex-Kontakt: ${new Date(brain.lastSeenAt).toLocaleString('de-DE')}`:'Wartet auf den ersten Kontakt der Codex-Automation.';
  $('#brain-pending').textContent=`${brain.pendingClips||0} Aufnahmen, ${brain.pendingReels||0} Reel-Aufträge und ${brain.pendingPhotos||0} Foto-Aufträge warten auf die Auswertung.`;
}
document.addEventListener('studio-brain',event=>{
  if(configuration?.analysisProvider!=='codex')return;configuration.brain=event.detail;
  $('#connection-status').textContent=!configuration.engineReady?'Schnittdienst prüfen':event.detail.online?'Codex verbunden':'Codex wartet auf Verbindung';
  $('#connection-status').className=`status-pill ${event.detail.online?'ready':''}`;updateBrainDialog();
});
function updateSubmit() {
  const quick = $('#quick-mode').checked;
  $('#reel-count').disabled = quick;
  const button = $('#create-button');
  button.disabled = !configuration?.engineReady;
  button.querySelector('span').textContent = quick ? 'Probeschnitt erstellen' : configuration?.analysisReady ? 'Reels erstellen' : 'Videoanalyse verbinden';
}

function updateStyleProfile(applyRecommendations = false) {
  const value = $('#reel-style-profile').value;
  const profile = configuration?.styleProfiles?.find(item => item.id === value);
  $('#reel-style-description').textContent = profile?.description || (value === 'late-night-drive'
    ? 'Ruhiger Mitfahrmoment · etwa 20–35 Sekunden · natürliche Nachtfarben · Originalton · kein Text im Film. Die genaue Länge folgt aus dem Material.'
    : 'Bestehender Reel-Stil mit einem passenden Einstieg, sichtbarer Handlung und optionalem Hook-Text.');
  if (applyRecommendations && value === 'late-night-drive') {
    $('#session-form [name="goal"]').value = 'atmosphere';
    $('#session-form [name="duration"]').value = '25';
  }
}

function renderFiles() {
  $('#file-list').innerHTML = files.map((file, index) => `<div class="file-chip"><span aria-hidden="true">↗</span><span>${escapeHtml(file.name)}</span><span class="size">${(file.size / 1024 ** 2).toFixed(1)} MB</span><button type="button" data-remove="${index}" aria-label="${escapeHtml(file.name)} entfernen">×</button></div>`).join('');
  if (!$('#session-title').value && files.length) $('#session-title').value = files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').slice(0,80);
}

function addFiles(selected) {
  if (librarySources.length) clearLibrarySources();
  for (const file of selected) if (!files.some(existing => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) files.push(file);
  renderFiles();
}

$('#videos').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
$('#file-list').addEventListener('click', event => { const button = event.target.closest('[data-remove]'); if (button) { files.splice(Number(button.dataset.remove), 1); renderFiles(); } });
for (const name of ['dragenter','dragover']) $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.add('dragover'); });
for (const name of ['dragleave','drop']) $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.remove('dragover'); });
$('#dropzone').addEventListener('drop', event => addFiles(event.dataTransfer.files));
$('#quick-mode').addEventListener('change', updateSubmit);
$('#reel-style-profile').addEventListener('change', () => updateStyleProfile(true));
function clearLibrarySources() { librarySources=[]; $('#reel-library-sources').hidden=true; $('#dropzone').hidden=false; }
function renderLibrarySources() {
  $('#dropzone').hidden=true;$('#reel-library-sources').hidden=false;
  $('#reel-library-list').innerHTML=librarySources.map(clip=>`<li>${escapeHtml(clip.title)} <span>${escapeHtml(clip.name)}</span></li>`).join('');
}
$('#reel-library-clear').addEventListener('click',clearLibrarySources);
document.addEventListener('library-selection',event=>{
  librarySources=event.detail; files=[]; renderFiles();
  renderLibrarySources();
  if(!$('#session-title').value) $('#session-title').value=(librarySources[0]?.collections?.[0] || 'Reel aus der Bibliothek').slice(0,80);
  document.dispatchEvent(new CustomEvent('studio-view',{detail:'reels'}));
});
$('#settings-open').addEventListener('click', () => (configuration?.analysisProvider==='codex'?$('#brain-dialog'):$('#settings-dialog')).showModal());
$('#brain-close').addEventListener('click',()=>$('#brain-dialog').close());
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#login-dialog').addEventListener('cancel', event => event.preventDefault());

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); errorMessage('#login-error', '');
  const button = event.target.querySelector('button'); button.disabled = true;
  try {
    await api('/api/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ password:$('#login-password').value }) });
    $('#login-password').value = ''; $('#login-dialog').close();
    await loadConfiguration(); await poll();
  } catch (error) { errorMessage('#login-error', error.message); }
  finally { button.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  if(uploadQueue.hasUnfinished()){toast('Bitte laufende Upload-Aufgaben zuerst beenden oder abschließen.');return;}
  await api('/api/logout', { method:'POST' }); location.reload();
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); errorMessage('#settings-error', '');
  const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    await api('/api/settings/analysis', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ key:$('#provider-key').value.trim() }) });
    $('#provider-key').value = ''; $('#settings-dialog').close(); $('#quick-mode').checked = false;
    await loadConfiguration(); toast('Videoanalyse verbunden. Du kannst jetzt deine Reels erstellen.');
  } catch (error) { errorMessage('#settings-error', error.message); }
  finally { button.disabled = false; }
});

$('#session-form').addEventListener('submit', event => {
  event.preventDefault(); errorMessage('#form-error', '');
  if (!configuration) return;
  if (!$('#quick-mode').checked && !configuration.analysisReady) { $('#settings-dialog').showModal(); return; }
  if (!files.length && !librarySources.length) { errorMessage('#form-error', 'Wähle zuerst mindestens eine Aufnahme aus.'); $('#videos').focus(); return; }
  if(files.length>configuration.maxFiles){errorMessage('#form-error',`Für einen Schnitt bis zu ${configuration.maxFiles} Clips auswählen. Große Sammlungen kannst du vollständig in der Footage-Bibliothek ablegen.`);return;}
  const musicFile = $('#reel-music-file').files[0] || null;
  if (musicFile && musicFile.size > 40 * 1024 ** 2) { errorMessage('#form-error', 'Die Musikdatei darf höchstens 40 MB groß sein.'); return; }
  const fields=Object.fromEntries(new FormData(event.target));delete fields.videos;delete fields.quick;
  fields.mode=$('#quick-mode').checked?'quick':'ai';fields.count=$('#quick-mode').checked?'1':$('#reel-count').value;
  let musicAttached = false;
  try {
    uploadQueue.enqueue({files,clips:librarySources,fields:{collection:fields.title,brief:fields.brief},kind:'reel',label:fields.title?.trim()||'Neue Reel-Session',
      afterUpload:async({id,clips})=>{
        try{
          if (musicFile && !musicAttached) {
            await api('/api/music/'+id,{method:'PUT',headers:{'Content-Type':'application/octet-stream','x-music-name':encodeURIComponent(musicFile.name)},body:musicFile});
            fields.musicId=id;musicAttached=true;
          }
          return await api('/api/jobs/from-library',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({...fields,assetIds:clips.map(clip=>clip.id),requestId:id})});}
        catch(error){
          // If the response was lost, check the stable job ID before offering a retry.
          try{return await api(`/api/jobs/${id}`);}catch{}
          throw new Error(`Originale bleiben gespeichert. ${error.message} Mit „Fortsetzen“ denselben Schnittauftrag erneut prüfen.`);
        }
      }});
    event.target.reset();files=[];clearLibrarySources();renderFiles();updateStyleProfile();updateSubmit();
    toast('Session läuft im Hintergrund. Den Fortschritt findest du unten rechts.');
  }catch(error){errorMessage('#form-error',error.message);}
});
const states = { queued:'WARTET', processing:'IN ARBEIT', 'waiting-brain':'WARTET AUF CODEX', 'no-reel':'KONTEXT FEHLT', done:'FERTIG', error:'PRÜFEN', cancelled:'ABGEBROCHEN' };
function jobMarkup(job) {
  const quick = job.options.mode === 'quick';
  const styleId = job.options.styleProfile || 'standard';
  const styleLabel = configuration?.styleProfiles?.find(profile => profile.id === styleId)?.label || (styleId === 'late-night-drive' ? 'Late Night Drive' : styleId === 'standard' ? 'Standard' : styleId);
  const outputs = job.outputs.map(output => `<div class="output-card"><video controls preload="none" playsinline poster="${escapeHtml(output.coverUrl)}" aria-label="${escapeHtml(output.title)}"><source src="${escapeHtml(output.videoUrl)}" type="video/mp4"></video><h4>${escapeHtml(output.title)}</h4><span class="output-meta">${output.duration.toFixed(1)} SEK · ${output.width} × ${output.height}</span><div class="output-actions"><a class="download" href="${escapeHtml(output.videoUrl)}?download=1">MP4 herunterladen</a><a href="${escapeHtml(output.coverUrl)}?download=1">Cover</a><button type="button" data-action="copy" data-index="${output.index}" data-id="${job.id}">Caption kopieren</button><a href="${escapeHtml(output.captionUrl)}?download=1">Caption-Datei</a>${output.timeline ? `<a href="/api/jobs/${job.id}/files/${escapeHtml(encodeURIComponent(output.timeline))}?download=1">Timeline</a>` : ''}${output.quality ? `<a href="/api/jobs/${job.id}/files/${escapeHtml(encodeURIComponent(output.quality))}?download=1">Technische Prüfung</a>` : ''}</div><p class="hypothesis"><strong>${quick ? 'Probeschnitt' : 'Testidee'}:</strong> ${escapeHtml(output.hypothesis)}</p></div>`).join('');
  return `<div class="job-top"><div><h3>${escapeHtml(job.title)}</h3><p class="job-date">${new Date(job.createdAt).toLocaleString('de-DE',{ dateStyle:'medium',timeStyle:'short' })} · ${job.assets.length} ${job.assets.length === 1 ? 'Aufnahme' : 'Aufnahmen'} · Stil: ${escapeHtml(styleLabel)}${job.options.musicId ? ' · Eigene Musik' : ''}</p></div><span class="badge ${quick ? 'quick' : job.status}">${quick ? 'PROBESCHNITT' : states[job.status] || job.status}</span></div><p class="job-stage">${escapeHtml(job.stage)}</p>${['queued','processing','waiting-brain'].includes(job.status) ? `<progress max="100" value="${job.progress || 0}" aria-label="Schnittfortschritt"></progress>` : ''}${job.error ? `<p class="error-message">${escapeHtml(job.error)}</p>` : ''}${job.summary ? `<p class="job-summary">${escapeHtml(job.summary)}</p>` : ''}${job.providerCleanupWarning ? '<p class="error-message">Eine temporäre Google-Datei konnte nicht zum Löschen bestätigt werden. Die Anbieter-Aufbewahrung gilt weiterhin.</p>' : ''}<div class="output-list">${outputs}</div><div class="job-actions">${['queued','processing','waiting-brain'].includes(job.status) ? `<button type="button" data-action="cancel" data-id="${job.id}">Verarbeitung abbrechen</button>` : `<button class="delete" type="button" data-action="delete" data-id="${job.id}">Session löschen</button>`}${['error','cancelled'].includes(job.status) ? `<button type="button" data-action="retry" data-id="${job.id}">Erneut starten</button>` : ''}${job.outputs.length ? `<a class="text-button" href="/api/jobs/${job.id}/files/plan.json?download=1">Schnittplan</a>` : ''}</div>`;
}

let currentJobs = [];
function renderJobs(jobs) {
  currentJobs = jobs;
  $('#session-count').textContent = jobs.length;
  $('#empty-state').hidden = Boolean(jobs.length);
  const ids = new Set(jobs.map(job => job.id));
  for (const element of $('#jobs').children) if (!ids.has(element.dataset.id)) { element.remove(); cardSignatures.delete(element.dataset.id); }
  for (let i=0;i<jobs.length;i++) {
    const job = jobs[i];
    const signature = JSON.stringify(job);
    let card = document.querySelector(`.job-card[data-id="${job.id}"]`);
    if (!card) { card = document.createElement('article'); card.className = 'job-card'; card.dataset.id = job.id; }
    if (cardSignatures.get(job.id) !== signature) { card.innerHTML = jobMarkup(job); cardSignatures.set(job.id,signature); }
    if ($('#jobs').children[i] !== card) $('#jobs').insertBefore(card,$('#jobs').children[i] || null);
  }
}

$('#jobs').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const { action, id, index } = button.dataset;
  if (action === 'delete' && !confirm('Diesen Reel-Auftrag und seine Exporte löschen? Die Originale bleiben in der Footage-Bibliothek.')) return;
  button.disabled = true;
  try {
    if (action === 'copy') { const output = currentJobs.find(job => job.id === id).outputs.find(output => output.index === Number(index)); await navigator.clipboard.writeText(output.captionText); toast('Caption kopiert.'); }
    else { await api(`/api/jobs/${id}${action === 'delete' ? '' : `/${action}`}`,{ method:action === 'delete' ? 'DELETE' : 'POST' }); await poll(); }
  } catch(error) { toast(error.message || 'Aktion fehlgeschlagen. Die Caption kannst du auch als Datei herunterladen.'); }
  finally { button.disabled = false; }
});

async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await api('/api/jobs'); renderJobs(data.jobs);
    if ($('#connection-status').textContent.startsWith('Verbindung unterbrochen')) await loadConfiguration();
  }
  catch(error) { if(error.status !== 401) $('#connection-status').textContent = 'Verbindung unterbrochen · neuer Versuch folgt'; }
  finally { pollTimer = setTimeout(poll, document.hidden ? 8000 : 2500); }
}

document.addEventListener('visibilitychange', () => { if(!document.hidden && configuration) poll(); });
document.addEventListener('studio-upload-complete',event=>{if(event.detail.kind==='reel')poll();});
(async () => { try { await loadConfiguration(); await poll(); } catch(error) { if(error.status !== 401) { $('#connection-status').textContent = 'Server nicht erreichbar'; errorMessage('#form-error',error.message); } } })();
