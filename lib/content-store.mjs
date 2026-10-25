import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validId } from './store.mjs';
import { fail, text, id, choice, integer, timestamp, handle, reelLink, digest, normalizedMeasurement, parseCsv, evidenceIds } from './content-validation.mjs';
import { productionBrief, learningSnapshot, validateLearningResult, activeMeasurements, validateProductionPlan, learningEvidenceCurrent } from './content-learning.mjs';
import { getStyleProfile } from './style-profiles.mjs';
import { normalizeMusicId } from './music.mjs';

const nowIso = () => new Date().toISOString();
const find = (items, value, label) => { const item = items.find(item => item.id === value); if (!item) throw fail(`${label} nicht gefunden.`, 404); return item; };
export class ContentStore {
  constructor(dataDir, { clock = () => new Date() } = {}) { this.root = path.join(dataDir, 'content'); this.clock = clock; this.lock = Promise.resolve(); }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await fs.readFile(path.join(this.root, 'state.json'), 'utf8'));
      if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.versions)) throw fail('Content-Speicher hat ein unbekanntes Format.', 500);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const accountId = randomUUID(), at = nowIso();
      this.state = { schemaVersion: 1, updatedAt: at, accounts: [{ id: accountId, handle: 'adrien.e39', accountType: 'business', positioning: '', goal: 'followers', createdAt: at,
        source: 'Nutzerauftrag vom 4. Oktober 2026; vollständige Positionierung offen.' }],
        styles: [{ id: randomUUID(), accountId, number: 1, createdAt: at, rules: [], provisionalPreset: 'Souverän, tatkräftig, präsent · Macher / Aura',
          scope: 'Vorläufiges Preset aus der Foto-Session. Nur einsetzen, wenn Hauptperson und sichtbare Handlung passen; Identität nicht aus Dateinamen ableiten.',
          source: '01-HEC-Stilprofil.md · vom Nutzer bereitgestellte Wünsche, keine Performance-Regel.' }],
        collections: [], concepts: [], versions: [], reviews: [], publications: [], measurements: [], imports: [], evidence: [], references: [], learningRuns: [],
        learnings: [{ id: randomUUID(), accountId, isTest: false, kind: 'process-feedback', title: 'Fotoablauf wiederverwenden',
          observation: 'Der Nutzer hat den bisherigen Fotoablauf positiv bewertet und möchte ihn wiederholen. Die externe Übergabe beschreibt dies als Prozessfeedback; Instagram-Ergebnisse fehlen.',
          nextExperiment: 'Sichtung mit Übersichten und Detailfenstern beibehalten; passende Motive weiterhin tatsächlich prüfen.', sourceIds: ['vault:02-HEC-Lernlog:L-2026-10-04-01'],
          sampleSize: 0, topic: 'Fotos', limitations: ['Keine gemessene Instagram-Wirkung.', 'Historische Nutzeraussage aus der Übergabe, kein aktueller Performance-Test.'],
          status: 'user-process-feedback', createdAt: at, author: 'user-handoff' }], receipts: {}, measurementSlots: [] };
      await this.save(this.state);
    }
    await this.transaction(state => {
      for (const profile of state.styles) profile.isTest ??= false;
      for (const account of state.accounts) if (!state.styles.some(item => item.accountId === account.id && item.isTest)) {
        const original = state.styles.filter(item => item.accountId === account.id && !item.isTest).at(-1);
        state.styles.push({ ...structuredClone(original), id: randomUUID(), isTest: true, number: 1, source: 'TEST: getrennte Kopie der vorläufigen Nutzerpräferenz; keine reale Profiländerung.' });
      }
      return { ok: true };
    });
  }
  async save(state) {
    const temp = path.join(this.root, `${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(temp, path.join(this.root, 'state.json'));
  }
  transaction(task) {
    const next = this.lock.catch(() => {}).then(async () => {
      const state = structuredClone(this.state), result = await task(state);
      if (digest(state) !== digest(this.state)) { state.updatedAt = this.clock().toISOString(); await this.save(state); this.state = state; }
      return structuredClone(result);
    });
    this.lock = next; return next;
  }
  receipt(state, requestId, payload, action) {
    id(requestId, 'Request-ID'); const key = requestId, fingerprint = digest(payload), previous = state.receipts[key];
    if (previous) { if (previous.hash !== fingerprint) throw fail('Diese Request-ID gehört zu einer anderen Änderung.', 409); return { ...previous.result, idempotent: true }; }
    const result = action(); state.receipts[key] = { hash: fingerprint, result, at: this.clock().toISOString() }; return result;
  }
  defaultAccount() { return this.state.accounts[0]; }
  version(value) { return find(this.state.versions, value, 'Schnittversion'); }
  versionForJob(jobId, outputIndex = 1) { return this.state.versions.find(item => item.jobId === jobId && item.outputIndex === outputIndex); }
  snapshot({ test = false } = {}) {
    const state = structuredClone(this.state), choose = items => items.filter(item => item.isTest === test);
    return { updatedAt: state.updatedAt, accounts: state.accounts, styles: choose(state.styles), collections: state.collections.filter(item => item.isTest === test),
      concepts: choose(state.concepts), versions: choose(state.versions), reviews: choose(state.reviews), publications: choose(state.publications),
      measurements: choose(state.measurements), activeMeasurementIds: activeMeasurements(state).filter(item => item.isTest === test).map(item => item.id),
      references: choose(state.references), learnings: choose(state.learnings).map(item => ({ ...item, evidenceCurrent: learningEvidenceCurrent(state, item, this.clock()) })), learningRuns: choose(state.learningRuns).map(({ facts, ...run }) => run),
      evidence: choose(state.evidence).map(({ filename, ...item }) => ({ ...item, url: `/api/content/evidence/${item.id}` })),
      imports: choose(state.imports).map(({ csv, ...item }) => item), measurementSlots: choose(state.measurementSlots) };
  }
  accountUpdate(accountId, raw) { return this.transaction(state => {
    if (raw.isTest === true) throw fail('Das reale Zielprofil kann im Testbereich nicht geändert werden. Test-Stilregeln werden getrennt gespeichert.');
    const account = find(state.accounts, accountId, 'Konto');
    if (raw.positioning !== undefined) account.positioning = text(raw.positioning, 1000, 'Positionierung');
    if (raw.goal !== undefined) account.goal = choice(raw.goal, ['followers', 'event', 'contacts'], 'Profilziel');
    if (raw.accountType !== undefined) account.accountType = choice(raw.accountType, ['unknown', 'business', 'creator', 'personal'], 'Kontotyp');
    account.updatedAt = this.clock().toISOString(); return account;
  }); }
  styleUpdate(accountId, raw) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'style', accountId, ...raw }, () => {
    find(state.accounts, accountId, 'Konto');
    if (!Array.isArray(raw.rules) || raw.rules.length > 20 || raw.confirmPermanent !== true) throw fail('Dauerhafte Stilwünsche bitte ausdrücklich bestätigen (höchstens 20).');
    const isTest = raw.isTest === true, previous = state.styles.filter(item => item.accountId === accountId && item.isTest === isTest).at(-1);
    const profile = { id: randomUUID(), accountId, isTest, number: (previous?.number || 0) + 1, rules: raw.rules.map(value => text(value, 500, 'Stilregel', true)),
      provisionalPreset: text(raw.provisionalPreset ?? previous?.provisionalPreset, 400, 'Vorläufiges Preset'), scope: text(raw.scope ?? previous?.scope, 700, 'Geltungsbereich'),
      createdAt: this.clock().toISOString(), source: 'Ausdrücklich vom Nutzer als dauerhafte Präferenz gespeichert.' };
    state.styles.push(profile); return profile;
  })); }
  collectionUpdate(raw, availableNames) { return this.transaction(state => {
    const accountId = id(raw.accountId || state.accounts[0].id, 'Konto'); find(state.accounts, accountId, 'Konto');
    const name = text(raw.name, 80, 'Sammlung', true);
    if (!availableNames.includes(name)) throw fail('Diese Sammlung ist nicht in der Bibliothek vorhanden.');
    const isTest = raw.isTest === true;
    let setting = state.collections.find(item => item.accountId === accountId && item.name === name && item.isTest === isTest);
    const input = { enabled: raw.enabled === true, checkMinutes: integer(Number(raw.checkMinutes ?? setting?.checkMinutes ?? 60), 5, 1440, 'Prüftakt in Minuten'),
      maxPerDay: integer(Number(raw.maxPerDay ?? setting?.maxPerDay ?? 1), 1, 10, 'Neue Konzepte pro Tag'), maxOpen: integer(Number(raw.maxOpen ?? setting?.maxOpen ?? 3), 1, 10, 'Offene Vorschläge'),
      duration: choice(Number(raw.duration ?? setting?.duration ?? 25), [15, 25, 35, 45], 'Gewünschte Länge'), goal: choice(raw.goal, ['followers', 'event', 'atmosphere'], 'Reel-Ziel', setting?.goal || 'followers'),
      styleProfile: getStyleProfile(raw.styleProfile === undefined ? setting?.styleProfile : raw.styleProfile).id,
      fit: choice(raw.fit, ['preserve', 'fill'], 'Bildausschnitt', setting?.fit || 'preserve'), subjectHint: text(raw.subjectHint ?? setting?.subjectHint, 500, 'Hauptpersonen'),
      timeZone: text(raw.timeZone || setting?.timeZone || 'Europe/Berlin', 80, 'Zeitzone', true) };
    try { new Intl.DateTimeFormat('de-DE', { timeZone: input.timeZone }).format(this.clock()); } catch { throw fail('Die Zeitzone ist ungültig.'); }
    if (!setting) { setting = { id: randomUUID(), accountId, name, isTest, createdAt: this.clock().toISOString() }; state.collections.push(setting); }
    Object.assign(setting, input, { updatedAt: this.clock().toISOString() }); return setting;
  }); }
  brief(accountId, options) { return productionBrief(this.state, accountId || this.defaultAccount().id, { ...options, now: this.clock() }); }
  makeVersion(state, concept, { jobId = randomUUID(), outputIndex = 1, parentVersion = null, requiresBriefing = true, options, assetIds }) {
    const at = this.clock().toISOString(), versions = state.versions.filter(item => item.conceptId === concept.id);
    const version = { id: randomUUID(), conceptId: concept.id, accountId: concept.accountId, number: versions.length + 1, isTest: concept.isTest,
      jobId, outputIndex, parentVersionId: parentVersion?.id || null, createdAt: at, renderStatus: 'reserved', reviewStatus: 'pending-render',
      plan: null, exports: null, requiresBriefing, assetIds: [...assetIds], options: { ...structuredClone(options), styleProfile: getStyleProfile(options?.styleProfile).id },
      briefing: productionBrief(state, concept.accountId, { collection: concept.collection, isTest: concept.isTest, topics: concept.topics || [], parentVersion, now: this.clock() }) };
    state.versions.push(version); concept.currentVersionId = version.id; concept.status = 'open'; return version;
  }
  registerJob(job) { return this.transaction(state => {
    const previous = state.versions.filter(item => item.jobId === job.id); if (previous.length) return previous;
    const accountId = job.options.accountId || state.accounts[0].id; find(state.accounts, accountId, 'Konto');
    const versions = [];
    for (let index = 1; index <= (job.options.count || 1); index++) {
      const concept = { id: randomUUID(), accountId, collection: job.options.collection || job.assets[0]?.collections?.[0] || '', title: job.title,
        source: 'manual', isTest: job.options.isTest === true, createdAt: job.createdAt, topics: [...new Set(job.assets.flatMap(asset => asset.catalog?.category ? [asset.catalog.category] : []))] };
      state.concepts.push(concept); versions.push(this.makeVersion(state, concept, { jobId: job.id, outputIndex: index, options: job.options, assetIds: job.assets.map(item => item.libraryId || item.id),
        requiresBriefing: !job.legacy && job.options.mode === 'codex' && !['done', 'no-reel', 'error', 'cancelled'].includes(job.status) }));
    }
    return versions;
  }); }
  reserveDraft(raw, clips) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'draft', ...raw }, () => {
    const accountId = id(raw.accountId || state.accounts[0].id, 'Konto'); find(state.accounts, accountId, 'Konto');
    const collection = text(raw.collection, 80, 'Sammlung');
    if (!Array.isArray(raw.assetIds) || !raw.assetIds.length || raw.assetIds.length > 12 || new Set(raw.assetIds).size !== raw.assetIds.length) throw fail('Eine bis zwölf unterschiedliche Aufnahmen auswählen.');
    const selected = raw.assetIds.map(value => { const clip = clips.find(item => item.id === value); if (!clip || clip.archived || clip.status !== 'ready') throw fail('Eine Aufnahme ist nicht verfügbar.'); return clip; });
    const title = text(raw.title || 'Neuer Reel-Versuch', 80, 'Titel', true);
    const concept = { id: randomUUID(), accountId, collection, title, isTest: raw.isTest === true, source: 'manual', createdAt: this.clock().toISOString(), topics: [...new Set(selected.map(item => item.category))] };
    state.concepts.push(concept);
    const musicId = normalizeMusicId(raw.musicId);
    const options = { title, brief: text(raw.brief, 1600, 'Kontext'), mode: 'codex', count: 1, duration: choice(Number(raw.duration ?? 25), [15, 25, 35, 45], 'Länge'),
      fit: choice(raw.fit, ['preserve', 'fill'], 'Bildausschnitt', 'preserve'), goal: choice(raw.goal, ['followers', 'event', 'atmosphere'], 'Ziel', 'followers'),
      styleProfile: getStyleProfile(raw.styleProfile).id, ...(musicId ? { musicId } : {}) };
    return this.makeVersion(state, concept, { options, assetIds: raw.assetIds });
  })); }
  reserveAutopilot(clips, { isTest = false } = {}) { return this.transaction(state => {
    const now = this.clock(), results = [];
    for (const setting of state.collections.filter(item => item.enabled && item.isTest === isTest)) {
      const collectionClips = clips.filter(clip => !clip.archived && clip.collections.includes(setting.name));
      const classified = clip => clip.classificationSource === 'codex' && clip.analysisStatus === 'done' && Boolean(clip.brainReview);
      const unavailable = setting.isTest ? [] : collectionClips.filter(clip => clip.status === 'error');
      const unclassified = setting.isTest ? [] : collectionClips.filter(clip => clip.status !== 'error' && (['queued', 'processing'].includes(clip.status) || !classified(clip)));
      setting.pendingClassificationCount = unclassified.length;
      setting.unavailableClipCount = unavailable.length;
      const waitReason = message => `${message}${unavailable.length ? ` ${unavailable.length} technisch nicht verfügbare Aufnahmen bleiben ungesichtet und ausgeschlossen.` : ''}`;
      if (unclassified.length) {
        const errors = unclassified.filter(clip => ['error', 'interrupted'].includes(clip.analysisStatus)).length;
        setting.waitReason = waitReason(`Zuerst alle verfügbaren Aufnahmen einsortieren: ${unclassified.length} Codex-Auswertungen offen${errors ? `, davon ${errors} mit Fehler oder Unterbrechung` : ''}.`);
        continue;
      }
      const unresolvedLearning = state.learningRuns.filter(run => run.accountId === setting.accountId && run.isTest === setting.isTest && ['queued', 'waiting-codex', 'error'].includes(run.status));
      if (unresolvedLearning.length) {
        setting.waitReason = waitReason(unresolvedLearning.some(run => run.status === 'error') ?
          'Ein Lernlauf ist fehlgeschlagen; vor einem neuen Vorschlag prüfen und gezielt erneut auswerten.' :
          'Zuerst das neue Feedback auswerten und im nächsten Reel-Briefing berücksichtigen.');
        continue;
      }
      if (setting.lastCheckAt && now.getTime() - Date.parse(setting.lastCheckAt) < setting.checkMinutes * 60000) continue;
      setting.lastCheckAt = now.toISOString();
      const concepts = state.concepts.filter(item => item.accountId === setting.accountId && item.collection === setting.name && item.isTest === setting.isTest);
      const open = concepts.filter(item => !['rejected', 'published', 'no-reel', 'exhausted'].includes(item.status)).length;
      const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: setting.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
      if (open >= setting.maxOpen) { setting.waitReason = waitReason('Die Obergrenze offener Vorschläge ist erreicht.'); continue; }
      if (concepts.filter(item => item.source === 'autopilot' && day(item.createdAt) === day(now)).length >= setting.maxPerDay) { setting.waitReason = waitReason('Die Tagesgrenze neuer Konzepte ist erreicht.'); continue; }
      const available = collectionClips.filter(clip => clip.status === 'ready' && (setting.isTest ||
        (classified(clip) && ['strong', 'supporting'].includes(clip.brainReview.assessment.use))));
      if (!available.length) { setting.waitReason = waitReason('Noch keine ausgewerteten tragfähigen Aufnahmen in dieser Sammlung.'); continue; }
      const useCount = clip => state.versions.filter(version => version.accountId === setting.accountId && version.isTest === setting.isTest && version.assetIds.includes(clip.id)).length;
      const selected = available.sort((a, b) => useCount(a) - useCount(b) || a.createdAt.localeCompare(b.createdAt)).slice(0, 8);
      const materialHash = digest({ sources: available.map(item => [item.id, item.updatedAt]).sort(), style: state.styles.filter(item => item.accountId === setting.accountId && item.isTest === setting.isTest).at(-1)?.id,
        duration: setting.duration, goal: setting.goal, fit: setting.fit, subjectHint: setting.subjectHint, styleProfile: getStyleProfile(setting.styleProfile).id });
      if (concepts.some(item => ['no-reel', 'exhausted'].includes(item.status) && item.materialHash === materialHash)) { setting.waitReason = waitReason('Material für weitere Geschichten ausgeschöpft; neue Aufnahme oder geänderte Vorgaben abwarten.'); continue; }
      const title = text(`Vorschlag · ${setting.name}`, 80, 'Titel', true), concept = { id: randomUUID(), accountId: setting.accountId, collection: setting.name, title,
        source: 'autopilot', isTest: setting.isTest, createdAt: now.toISOString(), materialHash, topics: [...new Set(selected.map(item => item.category))] };
      state.concepts.push(concept);
      const options = { title, mode: 'codex', count: 1, duration: setting.duration, goal: setting.goal, fit: setting.fit, brief: setting.subjectHint,
        styleProfile: getStyleProfile(setting.styleProfile).id };
      results.push(this.makeVersion(state, concept, { options, assetIds: selected.map(item => item.id) })); setting.waitReason = waitReason('Ein Vorschlag wurde reserviert.');
    }
    return results;
  }); }
  review(versionId, raw) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'review', versionId, ...raw }, () => {
    const version = find(state.versions, versionId, 'Schnittversion'), concept = find(state.concepts, version.conceptId, 'Reel-Konzept');
    const action = choice(raw.action, ['approve', 'reject', 'changes', 'feedback', 'process'], 'Review-Aktion'), stale = concept.currentVersionId !== version.id;
    if (['approve', 'reject', 'changes'].includes(action) && stale) throw fail('Diese Version ist überholt. Die aktuelle Version öffnen; Feedback zu älteren Versionen bleibt separat möglich.', 409);
    if (['approve', 'changes', 'reject'].includes(action) && version.renderStatus !== 'done') throw fail('Zuerst einen bestätigten Export abwarten.', 409);
    const feedback = text(raw.feedback, 1600, 'Feedback', ['changes', 'feedback', 'process'].includes(action));
    if (action === 'changes' && state.publications.some(item => item.versionId === version.id && item.mappingConfirmedAt)) throw fail('Diese Version wurde bereits veröffentlicht. Für eine neue Produktion ein eigenes Konzept anlegen.', 409);
    const review = { id: randomUUID(), accountId: version.accountId, versionId, action, feedback, stale, timeSeconds: null, isTest: version.isTest, createdAt: this.clock().toISOString() };
    if (raw.timeSeconds !== undefined && raw.timeSeconds !== null && raw.timeSeconds !== '') {
      const time = Number(raw.timeSeconds); if (!Number.isFinite(time) || time < 0 || time > (version.plan?.duration || 0)) throw fail('Feedback-Zeitmarke liegt außerhalb der Version.'); review.timeSeconds = time;
    }
    state.reviews.push(review);
    if (action === 'approve') { version.reviewStatus = 'approved'; version.approvedAt = review.createdAt; }
    if (action === 'reject') { version.reviewStatus = 'rejected'; concept.status = 'rejected'; }
    let revision = null;
    if (action === 'changes') { version.reviewStatus = 'changes-requested'; revision = this.makeVersion(state, concept, { options: version.options, assetIds: version.assetIds, parentVersion: version }); }
    return { review, revision };
  })); }
  validatePlan(jobId, raw, normalized) {
    const version = this.versionForJob(jobId); return validateProductionPlan(raw, normalized, version, this.state);
  }
  planReceived(jobId, plan) { return this.transaction(state => {
    for (const version of state.versions.filter(item => item.jobId === jobId)) {
      const reel = plan.reels[version.outputIndex - 1]; if (!reel) continue;
      if (version.plan && digest(version.plan) !== digest(reel)) throw fail('Der Schnittplan dieser Version ist bereits fest gespeichert.', 409);
      version.plan = structuredClone(reel); version.planHash = digest(reel); version.renderStatus = 'queued';
      find(state.concepts, version.conceptId, 'Reel-Konzept').title = reel.title;
    }
    return { ok: true };
  }); }
  jobObserved(job, exports = null) { return this.transaction(state => {
    for (const version of state.versions.filter(item => item.jobId === job.id)) {
      version.renderStatus = job.status; version.error = job.error || null;
      if (job.status === 'done' && exports?.[version.outputIndex - 1]) {
        const output = exports[version.outputIndex - 1];
        if (version.exports && version.exports.videoSha256 !== output.videoSha256) throw fail('Der bestätigte Export einer Version wurde unerwartet verändert.', 409);
        version.exports = output; if (version.reviewStatus === 'pending-render') version.reviewStatus = 'awaiting-review';
      }
      if (job.status === 'no-reel') { const concept = find(state.concepts, version.conceptId, 'Reel-Konzept'); concept.status = 'no-reel'; concept.reason = job.summary; version.reviewStatus = 'no-reel'; }
    }
    return { ok: true };
  }); }
  publicationVersion(state, raw, publication) {
    let version;
    if (raw.versionId) version = find(state.versions, id(raw.versionId, 'Version'), 'Schnittversion');
    else if (raw.reelId && raw.reelVersion) version = state.versions.find(item => (item.conceptId === raw.reelId || item.jobId === raw.reelId) && item.number === Number(raw.reelVersion));
    if (!version) throw fail('Konkrete Schnittversion fehlt.');
    if (version.accountId !== publication.accountId || version.isTest !== publication.isTest || !version.exports || version.renderStatus !== 'done') throw fail('Veröffentlichung und bestätigte Exportversion passen nicht zusammen.');
    return version;
  }
  publication(raw) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'publication', ...raw }, () => {
    const accountId = raw.accountId || state.accounts[0].id; find(state.accounts, accountId, 'Konto');
    const permalink = reelLink(raw.permalink), publishedAt = timestamp(raw.publishedAt, 'Veröffentlicht am'), isTest = raw.isTest === true;
    if (Date.parse(publishedAt) > this.clock().getTime() + 300000) throw fail('Eine erfolgte Veröffentlichung liegt nicht in der Zukunft.');
    let publication = state.publications.find(item => item.accountId === accountId && item.permalink === permalink && item.isTest === isTest);
    if (!publication) { publication = { id: randomUUID(), accountId, permalink, publishedAt, isTest, createdAt: this.clock().toISOString(), versionId: null,
      externalVariant: false, mappingHistory: [], instagramMediaId: text(raw.instagramMediaId, 80, 'Instagram-Media-ID'), source: 'user-report', mappingConfirmedAt: null }; state.publications.push(publication); }
    else if (publication.publishedAt !== publishedAt) throw fail('Dieser Link hat bereits eine andere Veröffentlichungszeit; Messungen und Zeitpunkt zuerst prüfen.', 409);
    if (raw.confirmMapping === true) this.confirmMapping(state, publication, raw);
    return publication;
  })); }
  confirmMapping(state, publication, raw) {
    if (raw.confirmMapping !== true) throw fail('Die Zuordnung muss ausdrücklich bestätigt werden.');
    const version = this.publicationVersion(state, raw, publication), external = raw.externalVariant === true;
    const nextVersionId = external ? null : version.id;
    if (publication.mappingConfirmedAt && (publication.versionId !== nextVersionId || publication.relatedVersionId !== version.id)) throw fail('Eine bestätigte Zuordnung zuerst zurücknehmen; ihre Historie bleibt erhalten.', 409);
    publication.relatedVersionId = version.id; publication.externalVariant = external; publication.versionId = nextVersionId;
    publication.mappingConfirmedAt ||= this.clock().toISOString(); publication.mappingSource = 'explicit-user-confirmation';
    if (!publication.mappingHistory.some(item => item.versionId === nextVersionId && item.externalVariant === external && item.action === 'confirmed')) publication.mappingHistory.push({ action: 'confirmed', versionId: nextVersionId, relatedVersionId: version.id, externalVariant: external, at: publication.mappingConfirmedAt });
    if (!external) find(state.concepts, version.conceptId, 'Reel-Konzept').status = 'published';
  }
  mapPublication(publicationId, raw) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'mapping', publicationId, ...raw }, () => {
    const publication = find(state.publications, publicationId, 'Veröffentlichung');
    if (raw.withdraw === true) {
      publication.mappingHistory.push({ action: 'withdrawn', versionId: publication.versionId, at: this.clock().toISOString(), reason: text(raw.reason, 700, 'Rücknahmegrund', true) });
      publication.versionId = null; publication.relatedVersionId = null; publication.mappingConfirmedAt = null;
    } else this.confirmMapping(state, publication, raw);
    return publication;
  })); }
  ingestIn(state, raw, { isTest = false, rawSource = 'manual' } = {}) {
    const input = normalizedMeasurement(raw, this.clock()), account = state.accounts.find(item => item.handle === input.accountHandle);
    if (!account) throw fail('Kontoname gehört zu keinem gespeicherten Zielkonto.');
    for (const evidenceId of input.evidenceIds) { const evidence = find(state.evidence, evidenceId, 'Beleg'); if (evidence.isTest !== isTest) throw fail('Testbeleg und echte Messung dürfen nicht vermischt werden.'); }
    let publication = state.publications.find(item => item.accountId === account.id && item.permalink === input.permalink && item.isTest === isTest);
    if (publication && publication.publishedAt !== input.publishedAt) throw fail('Dieser Link hat bereits eine andere Veröffentlichungszeit.');
    if (!publication) { publication = { id: randomUUID(), accountId: account.id, permalink: input.permalink, publishedAt: input.publishedAt,
      isTest, versionId: null, mappingConfirmedAt: null, externalVariant: false, mappingHistory: [], instagramMediaId: input.instagramMediaId, source: rawSource, createdAt: this.clock().toISOString() }; state.publications.push(publication); }
    if (input.proposedReelId) { publication.proposedReelId = input.proposedReelId; publication.proposedVersion = input.proposedVersion; }
    const { proposedReelId, proposedVersion, ...values } = input, fingerprint = digest({ ...values, publicationId: publication.id, isTest });
    const previous = state.measurements.find(item => item.fingerprint === fingerprint); if (previous) return { measurement: previous, publication, duplicate: true };
    if (input.correctionOf) {
      const corrected = find(state.measurements, input.correctionOf, 'Zu korrigierende Messung');
      if (corrected.publicationId !== publication.id || corrected.isTest !== isTest || corrected.measuredAt !== input.measuredAt) throw fail('Eine Korrektur muss dieselbe Veröffentlichung und denselben Messzeitpunkt betreffen.');
      if (state.measurements.some(item => item.correctionOf === corrected.id)) throw fail('Diese Messung wurde bereits korrigiert. Die aktuelle Korrektur auswählen.', 409);
    }
    const measurement = { ...values, id: randomUUID(), accountId: account.id, publicationId: publication.id, isTest, fingerprint, importedAt: this.clock().toISOString(), rawSource };
    state.measurements.push(measurement); return { measurement, publication, duplicate: false };
  }
  measurement(raw) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'measurement', ...raw }, () => this.ingestIn(state, raw, { isTest: raw.isTest === true }))); }
  metaMeasurement(raw, provenance, slotId = null) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'authorized-meta-measurement', ...raw, provenance, slotId }, () => {
    const saved = this.ingestIn(state, raw, { isTest: false, rawSource: 'meta-api' });
    saved.measurement.meta = structuredClone(provenance);
    saved.publication.instagramMediaId = provenance.instagramMediaId; saved.publication.metaOwnershipConfirmedAt = provenance.fetchedAt;
    if (slotId) {
      const slot = find(state.measurementSlots, slotId, 'Messpunkt');
      if (slot.publicationId !== saved.publication.id || slot.status !== 'scheduled') throw fail('Dieser geplante Messpunkt ist nicht mehr offen.', 409);
      slot.status = 'done'; slot.actualAt = provenance.fetchedAt; slot.measurementId = saved.measurement.id;
    }
    return saved;
  })); }
  importCsv(raw) { return this.transaction(state => {
    const isTest = raw.isTest === true, csv = raw.csv, rows = parseCsv(csv), hash = digest({ csv, isTest }), prior = state.imports.find(item => item.hash === hash);
    if (prior) return { ...prior.result, idempotent: true };
    const results = [], created = [];
    for (const row of rows) {
      if (row.error) { results.push({ line: row.line, error: row.error }); continue; }
      // Invalid rows do not leave half-created publications behind.
      const draft = structuredClone(state);
      try {
        const result = this.ingestIn(draft, row.value, { isTest, rawSource: 'csv' });
        Object.assign(state, draft); results.push({ line: row.line, measurementId: result.measurement.id, publicationId: result.publication.id, duplicate: result.duplicate });
        if (!result.duplicate) created.push(result.measurement.id);
      } catch (error) { results.push({ line: row.line, error: error.message.slice(0, 400) }); }
    }
    const result = { importId: randomUUID(), accepted: results.filter(item => !item.error).length, created: created.length, duplicates: results.filter(item => item.duplicate).length,
      errors: results.filter(item => item.error).length, rows: results, mappingNotice: 'Reel-ID und Version sind ein Zuordnungsvorschlag. Bestätigen im Studio ist separat erforderlich.' };
    state.imports.push({ id: result.importId, hash, isTest, csv, importedAt: this.clock().toISOString(), result }); return result;
  }); }
  reference(raw) { return this.transaction(state => this.receipt(state, raw.requestId, { kind: 'reference', ...raw }, () => {
    const accountId = raw.accountId || state.accounts[0].id; find(state.accounts, accountId, 'Konto');
    const reference = { id: randomUUID(), accountId, isTest: raw.isTest === true, url: reelLink(raw.url), observedAt: timestamp(raw.observedAt, 'Beobachtet am'),
      publishedAt: timestamp(raw.publishedAt, 'Referenz veröffentlicht am', { optional: true }), recheckAt: timestamp(raw.recheckAt, 'Erneut prüfen am'),
      source: choice(raw.source, ['user-reference', 'public-research'], 'Referenzquelle', 'user-reference'),
      features: { topic: text(raw.topic, 120, 'Thema', true), opening: text(raw.opening, 400, 'Sichtbarer Einstieg', true),
        action: text(raw.action, 500, 'Handlung'), cut: text(raw.cut, 300, 'Schnitt'), sound: text(raw.sound, 300, 'Ton'), text: text(raw.text, 400, 'Texteinsatz') },
      relevance: text(raw.relevance, 700, 'Zielgruppenbezug', true), experiment: text(raw.experiment, 700, 'Eigener Versuch', true),
      uncertainty: text(raw.uncertainty, 700, 'Unsicherheit', true), publicSignals: text(raw.publicSignals, 500, 'Sichtbare öffentliche Signale'),
      evidenceIds: evidenceIds(raw.evidenceIds), createdAt: this.clock().toISOString(), archived: false };
    if (Date.parse(reference.recheckAt) <= Date.parse(reference.observedAt) || Date.parse(reference.observedAt) > this.clock().getTime() + 300000) throw fail('Datierung oder erneuter Prüftermin der Referenz ist ungültig.');
    const duplicate = state.references.find(item => item.accountId === accountId && item.isTest === reference.isTest && item.url === reference.url && item.observedAt === reference.observedAt);
    if (duplicate) return duplicate;
    state.references.push(reference); return reference;
  })); }
  prepareLearning({ accountId = this.defaultAccount().id, isTest = false } = {}) { return this.transaction(state => {
    find(state.accounts, accountId, 'Konto');
    const pending = state.learningRuns.find(item => item.accountId === accountId && item.isTest === isTest && ['queued', 'waiting-codex'].includes(item.status));
    if (pending) return pending;
    const run = learningSnapshot(state, accountId, isTest, this.clock()); if (run) state.learningRuns.push(run); return run;
  }); }
  learningDone(runId, raw) { return this.transaction(state => {
    const run = find(state.learningRuns, runId, 'Lernlauf'), hash = digest(raw);
    if (run.status === 'done') { if (run.resultHash !== hash) throw fail('Lernlauf bereits mit anderem Ergebnis abgeschlossen.', 409); return { ok: true, idempotent: true }; }
    const result = validateLearningResult(raw, run); state.learnings.push(...result.learnings);
    Object.assign(run, { status: 'done', resultHash: hash, summary: result.summary, completedAt: this.clock().toISOString(), learningIds: result.learnings.map(item => item.id) });
    return { ok: true, learningIds: run.learningIds };
  }); }
}
