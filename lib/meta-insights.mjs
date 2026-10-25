import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, randomUUID } from 'node:crypto';
import { fail, digest, text, choice, reelLink } from './content-validation.mjs';

export const metaScopes = {
  facebook: ['instagram_basic', 'instagram_manage_insights', 'pages_show_list', 'pages_read_engagement'],
  instagram: ['instagram_business_basic', 'instagram_business_manage_insights'],
};
const definitions = {
  views: ['views', 1, 'count'], reach: ['reach', 1, 'accounts'], likes: ['likes', 1, 'count'], comments: ['comments', 1, 'count'],
  shares: ['shares', 1, 'count'], saved: ['saves', 1, 'count'], ig_reels_avg_watch_time: ['avg_watch_time_seconds', 1000, 'milliseconds'],
  ig_reels_video_view_total_time: ['total_watch_time_seconds', 1000, 'milliseconds'], follows: ['follows', 1, 'count'],
  facebook_views: [null, 1, 'count'], crossposted_views: [null, 1, 'count'],
};
const numericId = value => { if (!/^\d{5,40}$/.test(String(value))) throw fail('Meta-ID ist ungültig.'); return String(value); };
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

export class MetaInsights {
  constructor(config, content, { fetcher = fetch, clock = () => new Date() } = {}) {
    this.config = config; this.content = content; this.fetcher = fetcher; this.clock = clock; this.root = path.join(content.root, 'meta-private'); this.lock = Promise.resolve();
  }
  async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try { this.key = await fs.readFile(path.join(this.root, 'key')); } catch (error) { if (error.code !== 'ENOENT') throw error; this.key = randomBytes(32); await fs.writeFile(path.join(this.root, 'key'), this.key, { mode: 0o600, flag: 'wx' }); }
    try {
      const encrypted = JSON.parse(await fs.readFile(path.join(this.root, 'connection.enc.json'), 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.iv, 'base64')); decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
      this.private = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw fail('Geschützte Meta-Konfiguration konnte nicht gelesen werden.', 500); this.private = { status: 'not-configured', connection: null, settings: null, attempts: [], unsupported: {} }; }
    const connection = this.private.connection;
    if (connection && !this.private.lastLiveReadAt) {
      const latest = this.content.state.measurements.filter(item => !item.isTest && item.meta?.instagramUserId === connection.igUserId &&
        Date.parse(item.meta.fetchedAt) >= Date.parse(connection.connectedAt)).sort((a,b) => b.meta.fetchedAt.localeCompare(a.meta.fetchedAt))[0];
      if (latest) {
        this.private.lastLiveReadAt = latest.meta.fetchedAt; this.private.supported = latest.meta.rawMetrics.map(item => item.name); this.private.unsupported = latest.meta.unavailable;
        this.private.status = 'live-confirmed'; this.private.error = null; this.private.nextAttemptAt = null; await this.save();
      }
    }
  }
  async save() {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv), data = Buffer.concat([cipher.update(JSON.stringify(this.private)), cipher.final()]);
    const temp = path.join(this.root, `${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    await fs.rename(temp, path.join(this.root, 'connection.enc.json'));
  }
  exclusive(task) { const next = this.lock.catch(() => {}).then(task); this.lock = next; return next; }
  public() {
    const settings = this.private.settings, connection = this.private.connection;
    const expired = connection && Date.parse(connection.expiresAt) <= this.clock().getTime(), requiresLogin = expired || this.private.status === 'reauthorization-required';
    return { status: requiresLogin ? 'reauthorization-required' : this.private.status, configured: Boolean(settings?.appId && settings?.appSecret), appId: settings?.appId || '',
      loginMode: settings?.loginMode || 'facebook', apiVersion: settings?.apiVersion || 'v26.0', redirectUri: this.redirectUri(), requiredScopes: metaScopes[settings?.loginMode || 'facebook'],
      identityConfirmed: Boolean(connection) && !requiresLogin, accountHandle: connection?.username || null, instagramUserId: connection?.igUserId || null,
      grantedScopes: connection?.grantedScopes || [], expiresAt: connection?.expiresAt || null, liveInsightsConfirmed: Boolean(this.private.lastLiveReadAt),
      lastLiveReadAt: this.private.lastLiveReadAt || null, supportedMetrics: this.private.supported || [], unsupportedMetrics: this.private.unsupported || {},
      error: expired ? 'Die Meta-Anmeldung ist abgelaufen. Eigenes Konto erneut anmelden.' : this.private.error || null, nextAttemptAt: this.private.nextAttemptAt || null,
      notice: requiresLogin ? 'Eigenes Konto erneut anmelden; vorhandene Messungen bleiben erhalten.' : connection ? this.private.lastLiveReadAt ? 'Kontozuordnung und eigener Insights-Abruf bestätigt.' : 'Kontozuordnung bestätigt; eigener Insights-Abruf noch offen.' : 'Business-Konto und App vorhanden; im Studio konfigurieren und selbst anmelden.' };
  }
  redirectUri() { return new URL('/oauth/meta/callback', this.config.publicUrl || 'https://reels.127.0.0.1.sslip.io').href; }
  configure(raw) { return this.exclusive(async () => {
    const appId = numericId(raw.appId), loginMode = choice(raw.loginMode, ['facebook', 'instagram'], 'Meta-Anmeldeweg', 'facebook');
    const appSecret = raw.appSecret ? text(raw.appSecret, 256, 'App-Secret', true) : this.private.settings?.appSecret;
    if (!appSecret || appSecret.length < 20 || /\s/.test(appSecret)) throw fail('App-Secret in der geschützten Maske oder Serverkonfiguration hinterlegen.');
    const apiVersion = raw.apiVersion || 'v26.0'; if (!/^v\d{2}\.0$/.test(apiVersion)) throw fail('Eine feste Graph-API-Version wie v26.0 verwenden.');
    this.private.settings = { appId, appSecret, loginMode, apiVersion }; this.private.connection = null; this.private.lastLiveReadAt = null;
    this.private.status = 'configured'; this.private.error = null; this.private.nextAttemptAt = null; this.private.supported = []; this.private.unsupported = {}; await this.save(); return this.public();
  }); }
  begin() { return this.exclusive(async () => {
    const settings = this.private.settings; if (!settings) throw fail('Zuerst Meta-App-ID und App-Secret hinterlegen.', 409);
    const state = randomBytes(32).toString('base64url'), cookie = randomBytes(32).toString('base64url');
    this.private.pending = { stateHash: digest(state), cookieHash: digest(cookie), until: this.clock().getTime() + 15 * 60000 };
    await this.save();
    const url = new URL(settings.loginMode === 'instagram' ? 'https://www.instagram.com/oauth/authorize' : `https://www.facebook.com/${settings.apiVersion}/dialog/oauth`);
    for (const [key, value] of Object.entries({ client_id: settings.appId, redirect_uri: this.redirectUri(), response_type: 'code', scope: metaScopes[settings.loginMode].join(','), state })) url.searchParams.set(key, value);
    if (settings.loginMode === 'instagram') { url.searchParams.set('enable_fb_login', '0'); url.searchParams.set('force_authentication', '1'); }
    return { url: url.href, cookie };
  }); }
  async call(url, { method = 'GET', token, body } = {}) {
    let response;
    try { response = await this.fetcher(url, { method, redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined, signal: AbortSignal.timeout(20000) }); }
    catch { throw Object.assign(fail('Meta ist gerade nicht erreichbar. Der vorhandene Messstand bleibt erhalten.', 502), { metaCode: null }); }
    let data; try { data = await response.json(); } catch { throw fail('Meta lieferte keine lesbare API-Antwort.', 502); }
    if (!response.ok || data.error) {
      const code = Number(data.error?.code) || null;
      throw Object.assign(fail(code === 190 ? 'Meta-Anmeldung ist abgelaufen oder ungültig. Erneut anmelden.' : response.status === 429 || [4, 17, 32, 613].includes(code) ? 'Meta begrenzt Abrufe. Ein späterer Versuch wurde vorgesehen.' : 'Meta bestätigt diese Abfrage oder Berechtigung nicht.', response.status === 429 ? 429 : 502), { metaCode: code });
    }
    return data;
  }
  url(endpoint, params = {}, loginMode = this.private.settings.loginMode) {
    if (!/^[a-zA-Z0-9_/-]+$/.test(endpoint)) throw fail('Ungültiger Meta-Endpunkt.');
    const url = new URL(`/${this.private.settings.apiVersion}/${endpoint}`, loginMode === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com');
    for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value)); return url;
  }
  callback(raw, cookie) { return this.exclusive(async () => {
    const pending = this.private.pending;
    if (!pending || pending.until < this.clock().getTime() || !cookie || !raw.state || !equal(digest(raw.state), pending.stateHash) || !equal(digest(cookie), pending.cookieHash)) throw fail('Meta-Anmeldung ist abgelaufen oder gehört zu einer anderen Sitzung.', 403);
    this.private.pending = null; await this.save();
    if (raw.error || !raw.code) { this.private.status = 'authorization-declined'; this.private.error = 'Die Kontoanmeldung wurde nicht bestätigt.'; await this.save(); return this.public(); }
    const settings = this.private.settings;
    try {
      let token, expiresIn = 3600, grantedScopes = [], identity;
      if (settings.loginMode === 'instagram') {
        const exchanged = await this.call('https://api.instagram.com/oauth/access_token', { method: 'POST', body: { client_id: settings.appId, client_secret: settings.appSecret,
          grant_type: 'authorization_code', redirect_uri: this.redirectUri(), code: raw.code } });
        const short = exchanged.data?.[0] || exchanged;
        const longUrl = new URL('https://graph.instagram.com/access_token'); for (const [key, value] of Object.entries({ grant_type: 'ig_exchange_token', client_secret: settings.appSecret, access_token: short.access_token })) longUrl.searchParams.set(key, value);
        const long = await this.call(longUrl); token = long.access_token; expiresIn = Number(long.expires_in) || expiresIn;
        identity = await this.call(this.url('me', { fields: 'user_id,username' }), { token });
        grantedScopes = Array.isArray(short.permissions) ? short.permissions : [];
        if (!grantedScopes.length) { const permissions = await this.call(this.url('me/permissions'), { token }); grantedScopes = (permissions.data || []).filter(item => item.status === 'granted').map(item => item.permission); }
        identity = { username: identity.username, id: identity.user_id || identity.id, token };
      } else {
        const codeUrl = this.url('oauth/access_token', { client_id: settings.appId, client_secret: settings.appSecret, redirect_uri: this.redirectUri(), code: raw.code }, 'facebook');
        const short = await this.call(codeUrl), long = await this.call(this.url('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: settings.appId, client_secret: settings.appSecret, fb_exchange_token: short.access_token }, 'facebook'));
        token = long.access_token; expiresIn = Number(long.expires_in) || expiresIn;
        const debug = await this.call(this.url('debug_token', { input_token: token }, 'facebook'), { token: `${settings.appId}|${settings.appSecret}` });
        if (!debug.data?.is_valid || String(debug.data.app_id) !== settings.appId) throw fail('Meta bestätigt Token und App-Zuordnung nicht.', 403);
        grantedScopes = debug.data.scopes || [];
        let after; const accounts = [];
        for (let page = 0; page < 10; page++) {
          const data = await this.call(this.url('me/accounts', { fields: 'id,access_token,instagram_business_account{id,username}', limit: 100, after }, 'facebook'), { token });
          accounts.push(...(data.data || [])); after = data.paging?.cursors?.after; if (!data.paging?.next || !after) break;
        }
        const expected = this.content.defaultAccount().handle, matches = accounts.filter(item => item.instagram_business_account?.username?.toLowerCase() === expected);
        if (matches.length !== 1) throw fail('Die angemeldeten Facebook-Seiten enthalten nicht eindeutig @adrien.e39. Verknüpfte Instagram-Seite und Konto prüfen.', 409);
        const page = matches[0]; identity = { ...page.instagram_business_account, token: page.access_token };
      }
      const expected = this.content.defaultAccount().handle;
      if (identity.username?.toLowerCase() !== expected || !identity.token) throw fail('Angemeldetes Konto passt nicht zum Zielprofil @adrien.e39.', 403);
      if (!metaScopes[settings.loginMode].every(scope => grantedScopes.includes(scope))) throw fail('Die benötigten lesenden Insights-Berechtigungen wurden nicht vollständig bestätigt.', 403);
      this.private.connection = { igUserId: numericId(identity.id), username: expected, token: identity.token, userToken: token,
        grantedScopes, connectedAt: this.clock().toISOString(), expiresAt: new Date(this.clock().getTime() + expiresIn * 1000).toISOString() };
      this.private.status = 'identity-confirmed'; this.private.error = null; this.private.lastLiveReadAt = null; this.private.nextAttemptAt = null; await this.save(); return this.public();
    } catch (error) { this.private.status = 'connection-error'; this.private.error = error.status ? error.message : 'Meta-Anmeldung konnte nicht bestätigt werden.'; await this.save(); throw fail(this.private.error, error.status || 502); }
  }); }
  connection() {
    const connection = this.private.connection;
    if (!connection || Date.parse(connection.expiresAt) <= this.clock().getTime() || this.private.status === 'reauthorization-required') throw fail('Für Insights das eigene Konto im Studio anmelden oder die abgelaufene Anmeldung erneuern.', 409);
    return connection;
  }
  async media({ permalink = null, limit = 30 } = {}) {
    const connection = this.connection(); let after; const result = [];
    for (let page = 0; page < (permalink ? 10 : 1); page++) {
      const response = await this.call(this.url(`${connection.igUserId}/media`, { fields: 'id,media_type,media_product_type,permalink,timestamp', limit: permalink ? 100 : limit, after }), { token: connection.token });
      for (const media of response.data || []) {
        if (media.media_product_type !== 'REELS') continue;
        const candidate = { id: numericId(media.id), permalink: reelLink(media.permalink), publishedAt: media.timestamp, mediaType: media.media_type };
        result.push(candidate); if (permalink && candidate.permalink === permalink) return [candidate];
      }
      after = response.paging?.cursors?.after; if (!response.paging?.next || !after) break;
    }
    return permalink ? [] : result;
  }
  read(publicationId, { slotId = null } = {}) { return this.exclusive(async () => {
    const publication = this.content.state.publications.find(item => item.id === publicationId);
    if (!publication || publication.isTest) throw fail('Eigene reale Veröffentlichung für den Live-Abruf auswählen.');
    const connection = this.connection();
    if (this.private.nextAttemptAt && Date.parse(this.private.nextAttemptAt) > this.clock().getTime()) throw fail('Ein späterer Meta-Abruf ist bereits vorgesehen.', 429);
    const attemptId = randomUUID();
    try {
      const [media] = await this.media({ permalink: publication.permalink });
      if (!media) throw fail('Reel wurde nicht unter den eigenen erreichbaren Medien gefunden. Link, Konto und Rechte prüfen.', 409);
      if (Math.abs(Date.parse(media.publishedAt) - Date.parse(publication.publishedAt)) > 60000) throw fail('Instagram-Veröffentlichungszeit stimmt nicht mit dem gespeicherten Zeitpunkt überein. Zuordnung zuerst prüfen.', 409);
      const values = {}, rawMetrics = [], unavailable = {}, supported = [];
      for (const [metric, [field, divisor, unit]] of Object.entries(definitions)) {
        try {
          const response = await this.call(this.url(`${media.id}/insights`, { metric }), { token: connection.token });
          const record = response.data?.find(item => item.name === metric), value = record?.total_value?.value ?? record?.values?.at(-1)?.value;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { unavailable[metric] = 'Keine verfügbare numerische Kennzahl zurückgegeben.'; continue; }
          rawMetrics.push({ name: metric, value, unit, period: record.period || 'lifetime', platformScope: metric === 'facebook_views' ? 'facebook' : metric === 'crossposted_views' ? 'crosspost' : 'instagram' });
          if (field) values[field] = value / divisor; supported.push(metric);
        } catch (error) {
          if (error.metaCode === 190 || error.status === 429 || [4, 17, 32, 613].includes(error.metaCode)) throw error;
          unavailable[metric] = error.metaCode === 100 ? 'Für dieses Medium oder diese API-Version nicht unterstützt.' : 'Nicht verfügbar oder erforderliche Berechtigung fehlt.';
        }
      }
      if (!Object.values(values).some(value => value !== null)) throw fail('Meta hat keine verwendbaren Instagram-Kennzahlen bestätigt. Konto-, Insights-Rechte und Medium prüfen.', 409);
      const measuredAt = this.clock().toISOString();
      const saved = await this.content.metaMeasurement({ requestId: attemptId, accountHandle: connection.username, permalink: publication.permalink,
        publishedAt: publication.publishedAt, measuredAt, source: `meta-api:${this.private.settings.loginMode}:${this.private.settings.apiVersion}`, platformScope: 'instagram', distribution: 'unknown',
        metrics: values, instagramMediaId: media.id, notes: 'Tatsächlicher autorisierter Abruf. Bezahlte Ausspielung ist auf diesem lesenden Weg nicht bestätigt.' },
        { apiVersion: this.private.settings.apiVersion, loginMode: this.private.settings.loginMode, instagramUserId: connection.igUserId, instagramMediaId: media.id,
          fetchedAt: measuredAt, rawMetrics, unavailable, plannedSlotId: slotId }, slotId);
      this.private.lastLiveReadAt = measuredAt; this.private.status = 'live-confirmed'; this.private.error = null; this.private.nextAttemptAt = null;
      this.private.supported = [...new Set([...(this.private.supported || []), ...supported])]; this.private.unsupported = unavailable; await this.save();
      return { measurementId: saved.measurement.id, fetchedAt: measuredAt, supportedMetrics: supported, unavailable, status: this.public() };
    } catch (error) {
      this.private.error = error.status ? error.message : 'Meta-Abruf konnte nicht bestätigt werden.';
      if (error.metaCode === 190) this.private.status = 'reauthorization-required';
      else this.private.status = 'read-error';
      this.private.nextAttemptAt = new Date(this.clock().getTime() + 30 * 60000).toISOString();
      await this.save(); throw fail(this.private.error, error.status || 502);
    }
  }); }
  async tick() {
    if (!this.private.connection || this.private.status === 'reauthorization-required') return { pending: false };
    if (Date.parse(this.private.connection.expiresAt) <= this.clock().getTime()) {
      await this.exclusive(async () => { this.private.status = 'reauthorization-required'; this.private.error = 'Die Meta-Anmeldung ist abgelaufen. Eigenes Konto erneut anmelden.'; await this.save(); });
      return { pending: false, requiresLogin: true };
    }
    if (this.private.nextAttemptAt && Date.parse(this.private.nextAttemptAt) > this.clock().getTime()) return { pending: false, retryAt: this.private.nextAttemptAt };
    const now = this.clock(), selected = await this.content.transaction(state => {
      for (const publication of state.publications.filter(item => !item.isTest && item.mappingConfirmedAt && !item.externalVariant)) {
        for (const hours of [24, 72, 168]) if (!state.measurementSlots.some(item => item.publicationId === publication.id && item.hours === hours)) state.measurementSlots.push({ id: randomUUID(), publicationId: publication.id, isTest: false,
          hours, dueAt: new Date(Date.parse(publication.publishedAt) + hours * 3600000).toISOString(), status: 'scheduled' });
        const due = state.measurementSlots.filter(item => item.publicationId === publication.id && item.status === 'scheduled' && Date.parse(item.dueAt) <= now.getTime()).sort((a, b) => b.hours - a.hours);
        if (due.length) {
          for (const missed of due.slice(1)) { missed.status = 'missed'; missed.reason = 'Historische Gesamtsumme nicht verfügbar; der nächste Abruf speichert nur die tatsächliche Abrufzeit.'; }
          return due[0];
        }
      }
      return null;
    });
    if (!selected) return { pending: false };
    return this.read(selected.publicationId, { slotId: selected.id });
  }
  disconnect() { return this.exclusive(async () => { this.private.connection = null; this.private.pending = null; this.private.status = 'disconnected'; this.private.lastLiveReadAt = null; this.private.error = null; await this.save(); return this.public(); }); }
}
