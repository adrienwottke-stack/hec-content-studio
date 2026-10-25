import { uploadQueue } from './upload-queue.js';
export { uploadQueue };
const el=selector=>document.querySelector(selector);
const html=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const size=bytes=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GB`:bytes>=1024**2?`${(bytes/1024**2).toFixed(1)} MB`:`${Math.ceil(bytes/1024)} KB`;
const labels={queued:'Wartet',running:'Lädt hoch',pausing:'Wird pausiert',paused:'Pausiert',completing:'Auftrag wird angelegt',done:'Upload fertig',error:'Bitte prüfen',cancelled:'Beendet'};
let expanded=false;
function render(tasks) {
  const open=tasks.filter(task=>!['done','cancelled'].includes(task.status));
  const issues=open.filter(task=>['paused','error'].includes(task.status));
  const running=open.find(task=>['running','completing','pausing'].includes(task.status));
  el('#transfer-dock').hidden=!tasks.length;
  document.body.classList.toggle('has-upload-tasks',Boolean(tasks.length));
  el('#transfer-toggle').setAttribute('aria-expanded',String(expanded));
  el('#transfer-details').hidden=!expanded;
  el('#transfer-title').textContent=running?running.status==='completing'?'Schnittauftrag wird angelegt':`Upload läuft · ${running.percent} %`:
    issues.length?`${issues.length} ${issues.length===1?'Aufgabe wartet':'Aufgaben warten'} auf dich`:open.length?`${open.length} Uploads warten`:'Uploads abgeschlossen';
  el('#transfer-summary').textContent=running?`${running.label} · ${open.length>1?`${open.length-1} weitere in der Warteschlange`:`${running.saved} von ${running.files.length} Dateien gespeichert`}`:
    open.length?'Öffnen für Fortschritt, Pause und Fortsetzen':`${tasks.filter(task=>task.status==='done').length} ${tasks.filter(task=>task.status==='done').length===1?'Aufgabe erledigt':'Aufgaben erledigt'} · Details ansehen`;
  const total=open.reduce((sum,task)=>sum+task.total,0),loaded=open.reduce((sum,task)=>sum+task.loaded,0);
  el('#transfer-overall').value=total?loaded/total*100:100;
  el('#transfer-badge').textContent=open.length||'✓';
  const list=el('#transfer-list'),ids=new Set(tasks.map(task=>task.id));
  for(const card of [...list.children])if(!ids.has(card.dataset.id))card.remove();
  for(const task of tasks) {
    let card=list.querySelector(`[data-id="${task.id}"]`);
    if(!card){card=document.createElement('article');card.className='transfer-task';card.dataset.id=task.id;list.append(card);}
    const controls=['queued','running'].includes(task.status)?'<button type="button" data-transfer-action="pause">Pausieren</button>':
      ['paused','error'].includes(task.status)?'<button type="button" data-transfer-action="resume">Fortsetzen</button>':'';
    const cancel=['queued','running','paused','error'].includes(task.status)?'<button type="button" data-transfer-action="cancel">Beenden</button>':'';
    const remove=['done','cancelled'].includes(task.status)?'<button type="button" data-transfer-action="dismiss">Ausblenden</button>':'';
    const view=task.status==='done'?`<button type="button" data-transfer-action="view" data-view="${task.kind==='reel'?'reels':'library'}">${task.kind==='reel'?'Schnitt ansehen':'Bibliothek öffnen'}</button>`:'';
    const content=`<div class="transfer-task-heading"><strong>${html(task.label)}</strong><span class="transfer-state ${task.status}">${html(labels[task.status])}</span></div><p class="transfer-stage">${html(task.stage)}</p>${task.files.length?`<div class="transfer-file-summary"><span>${task.saved} / ${task.files.length} Dateien · ${size(task.loaded)} / ${size(task.total)}</span><span>${task.percent} %</span></div><progress max="100" value="${task.percent}" aria-label="${html(task.label)} Uploadfortschritt"></progress>`:''}${task.error?`<p class="error-message">${html(task.error)}</p>`:''}<div class="transfer-actions">${controls}${cancel}${view}${remove}</div><details class="transfer-files"><summary>${task.files.length?`${task.files.length} Dateien`:'Vorhandene Aufnahmen'} ansehen</summary><ul>${task.files.map(file=>`<li><span title="${html(file.name)}">${html(file.name)}</span><small>${html(file.error||file.status)}</small></li>`).join('')}</ul></details>`;
    // Do not replace a focused button on every XHR progress event.
    const focused=card.contains(document.activeElement),detailOpen=card.querySelector('details')?.open;
    if(card.dataset.markup!==content&&!focused){card.innerHTML=content;card.dataset.markup=content;if(detailOpen)card.querySelector('details').open=true;}
  }
}
uploadQueue.subscribe((tasks,{event,task}={})=>{
  render(tasks);
  if(event==='saved')document.dispatchEvent(new CustomEvent('studio-upload-saved',{detail:task}));
  if(event==='done') {
    document.dispatchEvent(new CustomEvent('studio-upload-complete',{detail:task}));
    const toast=el('#toast');toast.textContent=task.kind==='reel'?`${task.label}: Upload fertig, der Schnitt läuft auf dem Server.`:
      `${task.label}: ${task.saved} Dateien gespeichert${task.duplicates?` · ${task.duplicates} wiedererkannt`:''}.`;
    toast.hidden=false;setTimeout(()=>{toast.hidden=true;},5000);
  }
  if(event==='stopped'&&task.status==='error') {
    expanded=true;render(tasks);el('#transfer-notice').textContent=`${task.label}: Bitte den Upload prüfen.`;
  }
});
el('#transfer-toggle').addEventListener('click',()=>{expanded=!expanded;render(uploadQueue.list());});
el('#transfer-minimize').addEventListener('click',()=>{expanded=false;render(uploadQueue.list());el('#transfer-toggle').focus();});
el('#transfer-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-transfer-action]');if(!button)return;
  const id=button.closest('.transfer-task').dataset.id,action=button.dataset.transferAction;
  if(action==='view'){document.dispatchEvent(new CustomEvent('studio-view',{detail:button.dataset.view}));expanded=false;}
  else uploadQueue[action](id);
  // Button handlers may retain focus; update once after the explicit action.
  button.blur();render(uploadQueue.list());
});
document.querySelector('.brand').addEventListener('click',event=>{
  if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();document.dispatchEvent(new CustomEvent('studio-view',{detail:'library'}));
});
window.addEventListener('beforeunload',event=>{
  if(!uploadQueue.hasUnfinished())return;event.preventDefault();event.returnValue='';
});
