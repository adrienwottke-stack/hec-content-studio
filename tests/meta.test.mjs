import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContentStore } from '../lib/content-store.mjs';
import { MetaInsights, metaScopes } from '../lib/meta-insights.mjs';

const scratch = path.resolve('../../work/tests'), clock = () => new Date('2026-10-04T20:00:00Z');
async function fixture(t, override = {}) {
  await fs.mkdir(scratch, { recursive: true }); const root = await fs.mkdtemp(path.join(scratch, 'meta-'));
  t.after(async () => { if (!root.startsWith(scratch + path.sep)) throw new Error('Unexpected test path'); await fs.rm(root, { recursive: true, force: true }); });
  const content = new ContentStore(root, { clock }); await content.initialize();
  const counters = { insights: [], media: 0 };
  const fetcher = async (input, options = {}) => {
    const url = new URL(input), metric = url.searchParams.get('metric');
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname.endsWith('/oauth/access_token')) return json({ access_token: 'MOCK-USER-TOKEN-SECRET', expires_in: 5000000 });
    if (url.pathname.endsWith('/debug_token')) return json({ data: { is_valid: true, app_id: '12345678', scopes: override.scopes || metaScopes.facebook } });
    if (url.pathname.endsWith('/me/accounts')) return json({ data: [{ id: '22222222', access_token: 'MOCK-PAGE-TOKEN-SECRET', instagram_business_account: { id: '33333333', username: override.username || 'adrien.e39' } }] });
    if (url.pathname.endsWith('/33333333/media')) { counters.media++; return json({ data: [{ id: '44444444', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/HEC_META_TEST/', timestamp: '2026-09-27T20:00:00Z' }] }); }
    if (url.pathname.endsWith('/44444444/insights')) {
      counters.insights.push(metric);
      if (override.expired) return json({ error: { code: 190, message: 'Provider message must not leak tokens' } }, 400);
      if (override.limited) return json({ error: { code: 4 } }, 429);
      if (metric === 'views') return json({ data: [{ name: metric, period: 'lifetime', values: [{ value: 0 }] }] });
      if (metric === 'reach') return json({ data: [{ name: metric, period: 'lifetime', values: [{ value: 10 }] }] });
      if (metric === 'ig_reels_avg_watch_time') return json({ data: [{ name: metric, period: 'lifetime', values: [{ value: 1250 }] }] });
      if (metric === 'facebook_views') return json({ data: [{ name: metric, period: 'lifetime', values: [{ value: 99 }] }] });
      return json({ error: { code: 100, message: 'Unsupported' } }, 400);
    }
    throw new Error('Unexpected mocked endpoint ' + url.pathname);
  };
  const config = { publicUrl: 'https://example.test', production: true };
  const meta = new MetaInsights(config, content, { fetcher, clock }); await meta.initialize();
  await meta.configure({ appId: '12345678', appSecret: 'MOCK-APP-SECRET-ONLY-FOR-CONTRACT-TESTS', apiVersion: 'v26.0', loginMode: 'facebook' });
  return { meta, content, counters, config, fetcher, root };
}
async function connect(meta) { const begin = await meta.begin(); await meta.callback({ state: new URL(begin.url).searchParams.get('state'), code: 'MOCK-OAUTH-CODE' }, begin.cookie); return begin; }
test('OAuth is bound to the initiating browser, rejects replay, identity mismatch and missing scopes', async t => {
  const good = await fixture(t); const begin = await good.meta.begin(), state = new URL(begin.url).searchParams.get('state');
  await assert.rejects(() => good.meta.callback({ state, code: 'TEST' }, 'other-browser'), error => error.status === 403);
  await good.meta.callback({ state, code: 'TEST' }, begin.cookie);
  assert.equal(good.meta.public().identityConfirmed, true); assert.equal(good.meta.public().liveInsightsConfirmed, false);
  await assert.rejects(() => good.meta.callback({ state, code: 'TEST' }, begin.cookie), error => error.status === 403);
  const wrong = await fixture(t, { username: 'another.account' }); await assert.rejects(() => connect(wrong.meta), /nicht eindeutig/); assert.equal(wrong.meta.public().identityConfirmed, false);
  const scopes = await fixture(t, { scopes: ['instagram_basic'] }); await assert.rejects(() => connect(scopes.meta), /Berechtigungen/);
  assert.ok(metaScopes.facebook.every(scope => !/publish|messages|comments/.test(scope)));
});
test('protected Meta storage survives restart without returning secrets or claiming a simulated live account', async t => {
  const { meta, content, root, config, fetcher } = await fixture(t); await connect(meta);
  const raw = await fs.readFile(path.join(root, 'content/meta-private/connection.enc.json'), 'utf8'); assert.ok(!raw.includes('MOCK-'));
  assert.ok(!JSON.stringify(meta.public()).includes('SECRET')); assert.ok(!JSON.stringify(content.snapshot()).includes('MOCK-'));
  const restarted = new MetaInsights(config, content, { fetcher, clock }); await restarted.initialize(); assert.equal(restarted.public().identityConfirmed, true);
  assert.equal(restarted.public().liveInsightsConfirmed, false); assert.equal(restarted.public().apiVersion, 'v26.0');
});
test('actual read times, raw units, unsupported metrics and platform separation are preserved (mock provider)', async t => {
  const { meta, content } = await fixture(t); await connect(meta);
  const pub = await content.publication({ requestId: randomUUID(), permalink: 'https://www.instagram.com/reel/HEC_META_TEST/', publishedAt: '2026-09-27T20:00:00Z' });
  const read = await meta.read(pub.id); const saved = content.state.measurements[0];
  assert.equal(saved.values.views, 0); assert.equal(saved.values.likes, null); assert.equal(saved.values.avg_watch_time_seconds, 1.25);
  assert.equal(saved.ageHours, 168); assert.equal(saved.measuredAt, clock().toISOString()); assert.equal(saved.meta.rawMetrics.find(item => item.name === 'facebook_views').platformScope, 'facebook');
  assert.equal(saved.platformScope, 'instagram'); assert.equal(saved.distribution, 'unknown'); assert.ok(read.unavailable.likes);
  assert.ok(!JSON.stringify(saved).includes('TOKEN')); assert.equal(pub.versionId, null);
});
test('a late seven-day total cannot become a historical 24h or 72h reading (mock provider)', async t => {
  const { meta, content } = await fixture(t); await connect(meta);
  const pub = await content.publication({ requestId: randomUUID(), permalink: 'https://www.instagram.com/reel/HEC_META_TEST/', publishedAt: '2026-09-27T20:00:00Z' });
  await content.transaction(state => { state.publications[0].mappingConfirmedAt = clock().toISOString(); return {}; });
  await meta.tick(); const slots = content.state.measurementSlots;
  assert.equal(slots.find(item => item.hours === 24).status, 'missed'); assert.equal(slots.find(item => item.hours === 72).status, 'missed');
  assert.equal(slots.find(item => item.hours === 168).actualAt, clock().toISOString()); assert.equal(content.state.measurements.length, 1);
  await meta.tick(); assert.equal(content.state.measurements.length, 1);
});
test('expired tokens and rate limiting remain actionable rather than fabricated zero measurements (mock provider)', async t => {
  const expired = await fixture(t, { expired: true }); await connect(expired.meta);
  const pub = await expired.content.publication({ requestId: randomUUID(), permalink: 'https://www.instagram.com/reel/HEC_META_TEST/', publishedAt: '2026-09-27T20:00:00Z' });
  await assert.rejects(() => expired.meta.read(pub.id)); assert.equal(expired.meta.public().status, 'reauthorization-required'); assert.equal(expired.content.state.measurements.length, 0);
  const limited = await fixture(t, { limited: true }); await connect(limited.meta);
  const another = await limited.content.publication({ requestId: randomUUID(), permalink: pub.permalink, publishedAt: pub.publishedAt });
  await assert.rejects(() => limited.meta.read(another.id), error => error.status === 429); assert.ok(limited.meta.public().nextAttemptAt); assert.equal(limited.content.state.measurements.length, 0);
});
test('known expiry is visible before an API call and a failed scheduled read obeys backoff (mock provider)',async t=>{
 const expired=await fixture(t);await connect(expired.meta);expired.meta.private.connection.expiresAt='2026-10-01T00:00:00Z';
 assert.equal(expired.meta.public().status,'reauthorization-required');assert.equal(expired.meta.public().identityConfirmed,false);await expired.meta.tick();assert.equal(expired.meta.private.status,'reauthorization-required');assert.equal(expired.counters.insights.length,0);
 const limited=await fixture(t,{limited:true});await connect(limited.meta);await limited.content.publication({requestId:randomUUID(),permalink:'https://www.instagram.com/reel/HEC_META_TEST/',publishedAt:'2026-09-27T20:00:00Z'});
 await limited.content.transaction(state=>{state.publications[0].mappingConfirmedAt=clock().toISOString();return {};});await assert.rejects(()=>limited.meta.tick());const requests=limited.counters.insights.length;
 assert.ok((await limited.meta.tick()).retryAt);assert.equal(limited.counters.insights.length,requests);
});
test('measurement, ownership and scheduled slot commit together and recover after acknowledgement loss (mock provider)',async t=>{
 const {meta,content,config,fetcher}=await fixture(t);await connect(meta);
 await content.publication({requestId:randomUUID(),permalink:'https://www.instagram.com/reel/HEC_META_TEST/',publishedAt:'2026-09-27T20:00:00Z'});
 await content.transaction(state=>{state.publications[0].mappingConfirmedAt=clock().toISOString();return {};});
 meta.save=async()=>{throw new Error('TEST simulated acknowledgement failure after atomic content commit');};await assert.rejects(()=>meta.tick());
 assert.equal(content.state.measurements.length,1);assert.equal(content.state.measurementSlots.find(item=>item.hours===168).status,'done');assert.ok(content.state.measurements[0].meta.rawMetrics.length);
 const restarted=new MetaInsights(config,content,{fetcher,clock});await restarted.initialize();assert.ok(restarted.public().lastLiveReadAt);await restarted.tick();assert.equal(content.state.measurements.length,1);
});
