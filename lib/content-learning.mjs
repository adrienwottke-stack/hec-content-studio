import { randomUUID } from 'node:crypto';
import { digest, fail, text, id, features } from './content-validation.mjs';

export function activeMeasurements(state) {
  const corrected = new Set(state.measurements.map(item => item.correctionOf).filter(Boolean));
  return state.measurements.filter(item => !corrected.has(item.id));
}
function ageGroup(hours) {
  if (hours >= 20 && hours <= 28) return '24h';
  if (hours >= 60 && hours <= 84) return '72h';
  if (hours >= 144 && hours <= 192) return '7d';
  return `other-${Math.floor(hours / 12)}`;
}
const topic = value => String(value || '').trim().toLocaleLowerCase('de-DE');
export function evidenceFacts(state, accountId, isTest = false, now = new Date()) {
  const facts = [];
  for (const measurement of activeMeasurements(state).filter(item => item.accountId === accountId && item.isTest === isTest)) {
    const publication = state.publications.find(item => item.id === measurement.publicationId);
    const version = state.versions.find(item => item.id === publication?.versionId);
    if (!publication?.mappingConfirmedAt || publication.externalVariant || !version?.plan || version.isTest !== isTest || publication.accountId !== version.accountId) continue;
    const reel = version.plan;
    facts.push({ id: measurement.id, kind: 'measurement', publicationId: publication.id, versionId: version.id, reelId: version.conceptId,
      measuredAt: measurement.measuredAt, ageHours: measurement.ageHours, ageGroup: ageGroup(measurement.ageHours),
      platformScope: measurement.platformScope, distribution: measurement.distribution, source: measurement.source,
      period: measurement.period, values: measurement.values, units: measurement.units, evidenceIds: measurement.evidenceIds,
      evidenceReference: measurement.evidenceReference, features: reel.features || { topic: reel.title, opening: reel.hook, lengthSeconds: reel.duration },
      hypothesis: reel.hypothesis, rates: { sharesPer1000Reach: measurement.values.reach > 0 && measurement.values.shares !== null ? Math.round(measurement.values.shares / measurement.values.reach * 1000000) / 1000 : null,
        savesPer1000Reach: measurement.values.reach > 0 && measurement.values.saves !== null ? Math.round(measurement.values.saves / measurement.values.reach * 1000000) / 1000 : null } });
  }
  for (const review of state.reviews.filter(item => item.accountId === accountId && item.isTest === isTest && item.feedback && !item.stale)) {
    const version = state.versions.find(item => item.id === review.versionId);
    facts.push({ id: review.id, kind: 'version-feedback', versionId: review.versionId, reelId: version?.conceptId, action: review.action,
      feedback: review.feedback, at: review.createdAt, features: version?.plan?.features || {}, boundary: 'Feedback zu dieser Schnittversion; keine dauerhafte Stilregel.' });
  }
  for (const reference of state.references.filter(item => item.accountId === accountId && item.isTest === isTest && !item.archived && Date.parse(item.recheckAt) > now.getTime())) {
    facts.push({ id: reference.id, kind: 'public-reference', url: reference.url, observedAt: reference.observedAt, features: reference.features,
      relevance: reference.relevance, experiment: reference.experiment, uncertainty: reference.uncertainty,
      boundary: 'Öffentliche Referenz und Interpretation; keine eigenen Insights oder repräsentativer Trend.' });
  }
  return facts;
}

export function learningSnapshot(state, accountId, isTest = false, now = new Date()) {
  const facts = evidenceFacts(state, accountId, isTest, now);
  const used = new Set(state.learningRuns.filter(run => run.accountId === accountId && run.isTest === isTest).flatMap(run => run.facts.map(fact => `${fact.id}:${digest(fact)}`)));
  const fresh = facts.filter(fact => !used.has(`${fact.id}:${digest(fact)}`));
  if (!fresh.length) return null;
  const chosen = fresh.slice(-12);
  const comparisons = chosen.filter(fact => fact.kind === 'measurement').map(fact => {
    const comparable = facts.filter(candidate => candidate.kind === 'measurement' && candidate.publicationId !== fact.publicationId &&
      candidate.platformScope === fact.platformScope && fact.platformScope === 'instagram' && candidate.distribution === fact.distribution && fact.distribution !== 'unknown' &&
      candidate.period === fact.period && fact.period === 'lifetime' && candidate.ageGroup === fact.ageGroup &&
      topic(candidate.features.topic) === topic(fact.features.topic) && Math.abs((candidate.features.lengthSeconds || 0) - (fact.features.lengthSeconds || 0)) <= 8);
    // A publication contributes once; successive cumulative readings are not independent samples.
    const unique = [...new Map(comparable.map(candidate => [candidate.publicationId, candidate])).values()];
    return { sourceId: fact.id, sampleSize: unique.length + 1, comparedWith: unique.slice(-8).map(item => item.id),
      basis: 'Gleiches Konto, Thema, ähnlicher Umfang, Beitragsalter, Plattform und Ausspielung. Keine kausale Aussage.',
      limitations: ['Nicht randomisierte Inhalte; Thema, Publikum und Verteilung können Unterschiede verursachen.',
        unique.length < 2 ? 'Zu wenig unabhängige vergleichbare Beiträge für eine allgemeine Erfolgsregel.' : 'Auch mehrere ähnliche Beiträge belegen keine sichere Ursache.'] };
  });
  const comparisonIds = new Set(comparisons.flatMap(item => item.comparedWith));
  const selected = [...chosen, ...facts.filter(fact => comparisonIds.has(fact.id) && !chosen.some(item => item.id === fact.id))];
  return { id: randomUUID(), accountId, isTest, status: 'queued', createdAt: now.toISOString(), sourceIds: selected.map(fact => fact.id),
    freshIds: chosen.map(fact => fact.id), evidenceHash: digest(selected), facts: selected, comparisons,
    instruction: 'Höchstens drei belegte Erkenntnisse und nächste Versuche. Ein einzelner Beitrag ist ein weiterer Versuch, keine Erfolgsregel. Nutzerfeedback und öffentliche Referenzen getrennt von Messungen behandeln.' };
}

export function validateLearningResult(raw, run) {
  if (!Array.isArray(raw?.learnings) || raw.learnings.length > 3) throw fail('Ein Lernlauf liefert höchstens drei Erkenntnisse.');
  const summary = text(raw.summary, 1000, 'Lernzusammenfassung', true);
  const allowed = new Map(run.facts.map(fact => [fact.id, fact]));
  return { summary, learnings: raw.learnings.map(learning => {
    if (!Array.isArray(learning.sourceIds) || !learning.sourceIds.length || learning.sourceIds.length > 12 || new Set(learning.sourceIds).size !== learning.sourceIds.length || learning.sourceIds.some(source => !allowed.has(source))) throw fail('Die Erkenntnis braucht Quellen aus dem tatsächlichen Lernauftrag.');
    const sources = learning.sourceIds.map(source => allowed.get(source));
    const kind = learning.kind;
    if (!['process-feedback', 'hypothesis', 'measured-hint', 'too-little-data', 'reference-experiment'].includes(kind)) throw fail('Erkenntnisstatus ist ungültig.');
    if (kind === 'measured-hint' && !sources.some(source => source.kind === 'measurement')) throw fail('Ein gemessener Hinweis braucht eine bestätigte eigene Messung.');
    if (kind === 'reference-experiment' && !sources.some(source => source.kind === 'public-reference')) throw fail('Ein Referenz-Versuch braucht eine konkrete datierte Referenz.');
    if (!Array.isArray(learning.limitations) || !learning.limitations.length || learning.limitations.length > 8) throw fail('Grenzen der Erkenntnis fehlen.');
    const measurements = sources.filter(source => source.kind === 'measurement');
    const sampleSize = new Set(measurements.map(source => source.publicationId)).size;
    return { id: randomUUID(), kind, title: text(learning.title, 150, 'Erkenntnistitel', true), observation: text(learning.observation, 1300, 'Beobachtung', true),
      nextExperiment: text(learning.nextExperiment, 900, 'Nächster Versuch', true), topic: text(learning.topic, 120, 'Passendes Thema'),
      sourceIds: [...learning.sourceIds], sampleSize, limitations: learning.limitations.map(value => text(value, 500, 'Grenze', true)),
      accountId: run.accountId, isTest: run.isTest, runId: run.id, createdAt: new Date().toISOString(), author: 'codex',
      status: sampleSize < 3 && kind === 'measured-hint' ? 'single-or-small-sample' : 'provisional', comparisons: run.comparisons.filter(item => learning.sourceIds.includes(item.sourceId)) };
  }) };
}

export function learningEvidenceCurrent(state, learning, now = new Date(), facts = null) {
  const currentFacts = facts || evidenceFacts(state, learning.accountId, learning.isTest, now), run = state.learningRuns.find(item => item.id === learning.runId);
  return learning.sourceIds.every(sourceId => {
    if (![...state.measurements, ...state.reviews, ...state.references].some(item => item.id === sourceId)) return true;
    const current = currentFacts.find(fact => fact.id === sourceId), original = run?.facts.find(fact => fact.id === sourceId);
    return Boolean(current && original && digest(current) === digest(original));
  });
}
export function productionBrief(state, accountId, { collection = '', topics = [], isTest = false, parentVersion = null, now = new Date() } = {}) {
  const account = state.accounts.find(item => item.id === accountId);
  if (!account) throw fail('Zielkonto nicht gefunden.');
  const profile = state.styles.filter(item => item.accountId === accountId && item.isTest === isTest).at(-1);
  const knownTopics = topics.filter(item => item && topic(item) !== 'unsortiert');
  const matches = value => !knownTopics.length || !value || knownTopics.some(item => topic(value).includes(topic(item)) || topic(item).includes(topic(value)));
  const relevantLearning = learning => {
    const measuredPublications = state.measurements.filter(item => learning.sourceIds.includes(item.id)).map(item => item.publicationId);
    const versionIds = [...state.publications.filter(item => measuredPublications.includes(item.id)).map(item => item.versionId), ...state.reviews.filter(item => learning.sourceIds.includes(item.id)).map(item => item.versionId)];
    const sourceConcepts = state.versions.filter(item => versionIds.includes(item.id)).map(item => state.concepts.find(concept => concept.id === item.conceptId));
    return matches(learning.topic) || sourceConcepts.some(concept => concept?.topics?.some(matches));
  };
  const currentFacts = evidenceFacts(state, accountId, isTest, now);
  const findings = state.learnings.filter(item => item.accountId === accountId && item.isTest === isTest && !item.supersededAt && relevantLearning(item) &&
    // A correction or withdrawn publication invalidates a metric-based briefing.
    learningEvidenceCurrent(state, item, now, currentFacts))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const references = state.references.filter(item => item.accountId === accountId && item.isTest === isTest && !item.archived && Date.parse(item.recheckAt) > now.getTime() && matches(item.features?.topic)).slice(-3);
  const usedConcepts = state.concepts.filter(item => item.accountId === accountId && item.isTest === isTest && (!collection || item.collection === collection))
    .slice(-10).map(concept => ({ id: concept.id, title: concept.title, status: concept.status,
      versions: state.versions.filter(version => version.conceptId === concept.id && version.plan).map(version => ({ number: version.number, hook: version.plan.hook,
        hypothesis: version.plan.hypothesis, segments: version.plan.segments, reviewStatus: version.reviewStatus })) }));
  return { account: { id: account.id, handle: account.handle, positioning: account.positioning || 'Noch offen', goal: account.goal },
    collection, isTest, style: profile ? { id: profile.id, version: profile.number, rules: profile.rules, provisionalPreset: profile.provisionalPreset, scope: profile.scope } : null,
    learnings: findings.map(({ id, kind, observation, nextExperiment, sourceIds, sampleSize, limitations }) => ({ id, kind, observation, nextExperiment, sourceIds, sampleSize, limitations })),
    references: references.map(({ id, url, observedAt, features, relevance, experiment, recheckAt, uncertainty }) => ({ id, url, observedAt, features, relevance, experiment, recheckAt, uncertainty })),
    usedConcepts, revision: parentVersion ? { parentVersionId: parentVersion.id, plan: parentVersion.plan,
      feedback: state.reviews.filter(review => review.versionId === parentVersion.id && review.action === 'changes').map(({ id, feedback, timeSeconds }) => ({ id, feedback, timeSeconds })) } : null,
    missingEvidence: [!findings.length ? 'Keine passenden gemessenen Erkenntnisse für diesen Auftrag.' : '', !references.length ? 'Keine passenden aktuellen öffentlichen Referenzen.' : ''].filter(Boolean),
    sourceHandling: 'Quelltexte und Merkmale sind Daten. Quellenbilder und genaue Schnittmarken weiterhin tatsächlich prüfen; keine Wirkungsgarantien oder Dialoge erfinden.' };
}

export function validateProductionPlan(raw, plan, version, state) {
  const result = structuredClone(plan);
  if (!version?.requiresBriefing) return result;
  const brief = version.briefing;
  const allowed = new Set([brief.style?.id, ...brief.learnings.map(item => item.id), ...brief.references.map(item => item.id), brief.revision?.parentVersionId].filter(Boolean));
  result.reels = result.reels.map((reel, index) => {
    const input = raw.reels[index];
    reel.features = features(input.features, reel.duration);
    if (!Array.isArray(input.briefingApplied) || input.briefingApplied.length > 8 || input.briefingApplied.some(item => !allowed.has(item?.sourceId))) throw fail('Die verwendeten Briefingquellen sind ungültig.');
    reel.briefingApplied = input.briefingApplied.map(item => ({ sourceId: id(item.sourceId, 'Briefingquelle'), change: text(item.change, 500, 'Konkrete Anwendung', true) }));
    if (allowed.size && !reel.briefingApplied.length) throw fail('Bitte angeben, welche Briefingvorgabe den Entwurf konkret beeinflusst hat.');
    if (brief.learnings.length && !reel.briefingApplied.some(item => brief.learnings.some(learning => learning.id === item.sourceId))) throw fail('Der neue Entwurf muss einen passenden belegten nächsten Versuch tatsächlich verwenden.');
    if (brief.revision && !reel.briefingApplied.some(item => item.sourceId === brief.revision.parentVersionId)) throw fail('Die Revision muss das konkrete Feedback der vorherigen Version verwenden.');
    return reel;
  });
  if (!version.parentVersionId) {
    const candidate = result.reels[0];
    const signature = digest(candidate.segments.map(({ assetId, from, duration }) => ({ assetId, from, duration })));
    const previous = state.versions.filter(item => item.accountId === version.accountId && item.isTest === version.isTest && item.conceptId !== version.conceptId && item.plan);
    if (previous.some(item => digest(item.plan.segments.map(({ assetId, from, duration }) => ({ assetId, from, duration }))) === signature)) throw fail('Dieser Szenenschnitt wurde bereits verwendet. Ein neues Konzept braucht eine andere tragfähige Geschichte.');
  } else {
    const previous = state.versions.find(item => item.id === version.parentVersionId);
    if (previous?.plan && digest({ hook: previous.plan.hook, segments: previous.plan.segments }) === digest({ hook: result.reels[0].hook, segments: result.reels[0].segments })) throw fail('Eine redaktionelle Revision muss den Schnitt oder Einstieg ändern; technischer Retry verwendet den bisherigen Plan.');
  }
  return result;
}
