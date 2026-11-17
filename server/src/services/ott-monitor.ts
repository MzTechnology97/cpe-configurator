import { nowIso, type Db } from '../db.ts';
import { publicFetch } from '../net/public-fetch.ts';

/**
 * «Servizi OTT e CDN» (module ott_monitor, Carmelo 15/11/2026): a free «Downdetector» of our own
 * for the services our customers use (streaming, social, cloud, gaming) and the CDNs that carry
 * them. Two free sources, nothing paid and no scraping:
 * - our probes: every minute the server opens each service as a customer would (DNS, connection,
 *   first answer) from our network, and measures the time;
 * - the official status pages, where the service publishes one in a public format (Atlassian
 *   Statuspage, Google), every 5 minutes.
 * When most services fail together the problem is ours (our exit to Internet), not theirs.
 */

export const OTT_CATEGORIES = ['streaming', 'social', 'cloud', 'gaming', 'cdn', 'altro'] as const;
export type OttCategory = (typeof OTT_CATEGORIES)[number];
export const STATUS_KINDS = ['none', 'statuspage', 'google'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];
export type OttState = 'ok' | 'lento' | 'irraggiungibile' | 'sconosciuto';
export type Official = 'ok' | 'minor' | 'major' | 'manutenzione' | 'sconosciuto';

export const MAX_SERVICES = 80;
const PROBE_TIMEOUT_MS = 8000;
const STATUS_TIMEOUT_MS = 10_000;
/** Consecutive failed probes before «irraggiungibile» (one lost probe is not an outage). */
const FAILS_FOR_DOWN = 3;
/** Slow: over 3 times the usual time (median of the last day) and over 1.5 s. */
const SLOW_FACTOR = 3;
const SLOW_MIN_MS = 1500;
const KEEP_HOURS = 48;

export interface ServiceInput {
  name: string;
  category: OttCategory;
  probeUrl: string;
  statusKind: StatusKind;
  statusUrl?: string;
  enabled?: boolean;
}
export interface Service extends Required<ServiceInput> {
  id: number;
  state: OttState;
  since: string | null;
  lastMs: number | null;
  baselineMs: number | null;
  official: Official;
  officialText: string;
  checkedAt: string | null;
  /** Average time and failures per 15 minutes, last 24 hours (for the little graph). */
  spark: Array<{ at: string; ms: number | null; fails: number }>;
}

/** The services at the first start: the admins add, change or remove them from the page. */
export const DEFAULT_SERVICES: ServiceInput[] = [
  { name: 'Google', category: 'cloud', probeUrl: 'https://www.google.com/generate_204', statusKind: 'google', statusUrl: 'https://www.google.com/appsstatus/dashboard/incidents.json' },
  { name: 'YouTube', category: 'streaming', probeUrl: 'https://www.youtube.com/generate_204', statusKind: 'none' },
  { name: 'Netflix', category: 'streaming', probeUrl: 'https://www.netflix.com/', statusKind: 'none' },
  { name: 'Prime Video', category: 'streaming', probeUrl: 'https://www.primevideo.com/', statusKind: 'none' },
  { name: 'Disney+', category: 'streaming', probeUrl: 'https://www.disneyplus.com/', statusKind: 'none' },
  { name: 'DAZN', category: 'streaming', probeUrl: 'https://www.dazn.com/', statusKind: 'none' },
  { name: 'RaiPlay', category: 'streaming', probeUrl: 'https://www.raiplay.it/', statusKind: 'none' },
  { name: 'Mediaset Infinity', category: 'streaming', probeUrl: 'https://mediasetinfinity.mediaset.it/', statusKind: 'none' },
  { name: 'Spotify', category: 'streaming', probeUrl: 'https://open.spotify.com/', statusKind: 'none' },
  { name: 'Twitch', category: 'streaming', probeUrl: 'https://www.twitch.tv/', statusKind: 'none' },
  { name: 'WhatsApp', category: 'social', probeUrl: 'https://web.whatsapp.com/', statusKind: 'none' },
  { name: 'Facebook', category: 'social', probeUrl: 'https://www.facebook.com/', statusKind: 'none' },
  { name: 'Instagram', category: 'social', probeUrl: 'https://www.instagram.com/', statusKind: 'none' },
  { name: 'TikTok', category: 'social', probeUrl: 'https://www.tiktok.com/', statusKind: 'none' },
  { name: 'Discord', category: 'social', probeUrl: 'https://discord.com/', statusKind: 'statuspage', statusUrl: 'https://discordstatus.com' },
  { name: 'Microsoft 365 / Outlook', category: 'cloud', probeUrl: 'https://outlook.office.com/', statusKind: 'none' },
  { name: 'Microsoft Teams', category: 'cloud', probeUrl: 'https://teams.microsoft.com/', statusKind: 'none' },
  { name: 'Zoom', category: 'cloud', probeUrl: 'https://zoom.us/', statusKind: 'statuspage', statusUrl: 'https://status.zoom.us' },
  { name: 'iCloud', category: 'cloud', probeUrl: 'https://www.icloud.com/', statusKind: 'none' },
  { name: 'Dropbox', category: 'cloud', probeUrl: 'https://www.dropbox.com/', statusKind: 'statuspage', statusUrl: 'https://status.dropbox.com' },
  { name: 'GitHub', category: 'cloud', probeUrl: 'https://github.com/', statusKind: 'statuspage', statusUrl: 'https://www.githubstatus.com' },
  { name: 'PlayStation Network', category: 'gaming', probeUrl: 'https://www.playstation.com/', statusKind: 'none' },
  { name: 'Xbox', category: 'gaming', probeUrl: 'https://www.xbox.com/', statusKind: 'none' },
  { name: 'Steam', category: 'gaming', probeUrl: 'https://store.steampowered.com/', statusKind: 'none' },
  { name: 'Cloudflare', category: 'cdn', probeUrl: 'https://www.cloudflare.com/cdn-cgi/trace', statusKind: 'statuspage', statusUrl: 'https://www.cloudflarestatus.com' },
  { name: 'Akamai', category: 'cdn', probeUrl: 'https://www.akamai.com/', statusKind: 'statuspage', statusUrl: 'https://www.akamaistatus.com' },
  { name: 'Fastly', category: 'cdn', probeUrl: 'https://www.fastly.com/', statusKind: 'statuspage', statusUrl: 'https://www.fastlystatus.com' },
  { name: 'Amazon CloudFront / AWS', category: 'cdn', probeUrl: 'https://aws.amazon.com/', statusKind: 'none' },
];

// ---- pure helpers (tested) -----------------------------------------------------------------------

/** An address we may probe: https (or http), a public name, no credentials. */
export function probeUrlProblem(u: string): string | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return 'url_invalid';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url_protocol';
  if (url.username || url.password) return 'url_credentials';
  if (!url.hostname.includes('.') || /^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname)) return 'url_not_public';
  return null;
}

/** Atlassian Statuspage (/api/v2/summary.json): the overall indicator and the open incidents. */
export function readStatuspage(body: unknown): { official: Official; text: string } {
  const b = body as { status?: { indicator?: string; description?: string }; incidents?: Array<{ name?: string; status?: string }>; scheduled_maintenances?: Array<{ name?: string; status?: string }> };
  const ind = b?.status?.indicator;
  if (!ind) return { official: 'sconosciuto', text: 'formato non riconosciuto' };
  const open = (b.incidents ?? []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem').map((i) => i.name ?? '').filter(Boolean);
  const maint = (b.scheduled_maintenances ?? []).filter((m) => m.status === 'in_progress').map((m) => m.name ?? '').filter(Boolean);
  const official: Official = ind === 'none' ? (maint.length ? 'manutenzione' : 'ok') : ind === 'minor' ? 'minor' : ind === 'maintenance' ? 'manutenzione' : 'major';
  return { official, text: [...open, ...maint].slice(0, 3).join(' · ') || (b.status?.description ?? '') };
}

/** Google (incidents.json): the incidents still open (no «end»). */
export function readGoogle(body: unknown): { official: Official; text: string } {
  if (!Array.isArray(body)) return { official: 'sconosciuto', text: 'formato non riconosciuto' };
  const open = body.filter((i) => i && typeof i === 'object' && !(i as { end?: unknown }).end) as Array<{ severity?: string; external_desc?: string; service_name?: string }>;
  if (!open.length) return { official: 'ok', text: '' };
  const high = open.some((i) => i.severity === 'high');
  return { official: high ? 'major' : 'minor', text: open.slice(0, 3).map((i) => `${i.service_name ?? ''}: ${(i.external_desc ?? '').split('\n')[0]}`.trim()).join(' · ').slice(0, 300) };
}

/** The state from the last probes: down after 3 failures in a row, slow over 3 times the usual. */
export function stateOf(recent: Array<{ ok: boolean; ms: number | null }>, baselineMs: number | null): OttState {
  if (!recent.length) return 'sconosciuto';
  const last = recent.slice(-FAILS_FOR_DOWN);
  if (last.length >= FAILS_FOR_DOWN && last.every((s) => !s.ok)) return 'irraggiungibile';
  const lastOk = [...recent].reverse().find((s) => s.ok);
  if (lastOk?.ms != null && baselineMs != null && lastOk.ms > Math.max(SLOW_MIN_MS, baselineMs * SLOW_FACTOR)) {
    // slow only if the last two good probes are both slow
    const oks = recent.filter((s) => s.ok).slice(-2);
    if (oks.length === 2 && oks.every((s) => (s.ms ?? 0) > Math.max(SLOW_MIN_MS, baselineMs * SLOW_FACTOR))) return 'lento';
  }
  return 'ok';
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
};

// ---- service -------------------------------------------------------------------------------------

type Row = {
  id: number;
  name: string;
  category: OttCategory;
  probe_url: string;
  status_kind: StatusKind;
  status_url: string;
  enabled: number;
  state: OttState;
  since: string | null;
  last_ms: number | null;
  baseline_ms: number | null;
  official: Official;
  official_text: string;
  checked_at: string | null;
};

export function createOttMonitor(
  db: Db,
  opts: {
    fetchImpl?: typeof fetch;
    isOn: () => boolean;
    /** To the NOC (page Notifiche, and Telegram if chosen). */
    notice: (title: string, lines: string[]) => void;
    group?: (html: string) => void;
    log?: (m: string) => void;
    now?: () => Date;
  },
) {
  const f = opts.fetchImpl ?? publicFetch();
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = () => opts.now?.() ?? new Date();
  let probing: Promise<void> | null = null;
  let lastOutage = false;

  function seed() {
    if ((db.prepare("SELECT value FROM settings WHERE key = 'ott.seeded'").get() as { value: string } | undefined)?.value) return;
    for (const [i, s] of DEFAULT_SERVICES.entries()) insert(s, i);
    db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('ott.seeded', '1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(nowIso());
  }
  function insert(s: ServiceInput, sort: number) {
    return db
      .prepare("INSERT INTO ott_services(name, category, probe_url, status_kind, status_url, enabled, sort, state, official, official_text) VALUES(?,?,?,?,?,?,?, 'sconosciuto', 'sconosciuto', '')")
      .run(s.name.trim(), s.category, s.probeUrl.trim(), s.statusKind, (s.statusUrl ?? '').trim().replace(/\/+$/, ''), s.enabled === false ? 0 : 1, sort);
  }

  const rows = () => db.prepare('SELECT * FROM ott_services ORDER BY sort, id').all() as Row[];

  function spark(id: number): Service['spark'] {
    const since = new Date(now().getTime() - 24 * 3600_000).toISOString();
    const r = db
      .prepare(
        `SELECT substr(at, 1, 14) || printf('%02d', (CAST(substr(at, 15, 2) AS INTEGER) / 15) * 15) slot, AVG(CASE WHEN ok = 1 THEN ms END) ms, SUM(1 - ok) fails
           FROM ott_samples WHERE service_id = ? AND at >= ? GROUP BY slot ORDER BY slot`,
      )
      .all(id, since) as Array<{ slot: string; ms: number | null; fails: number }>;
    return r.map((x) => ({ at: `${x.slot}:00Z`, ms: x.ms == null ? null : Math.round(x.ms), fails: x.fails }));
  }

  const toService = (r: Row, withSpark: boolean): Service => ({
    id: r.id,
    name: r.name,
    category: r.category,
    probeUrl: r.probe_url,
    statusKind: r.status_kind,
    statusUrl: r.status_url,
    enabled: !!r.enabled,
    state: r.enabled ? r.state : 'sconosciuto',
    since: r.since,
    lastMs: r.last_ms,
    baselineMs: r.baseline_ms,
    official: r.official,
    officialText: r.official_text,
    checkedAt: r.checked_at,
    spark: withSpark ? spark(r.id) : [],
  });

  const list = (withSpark = true) => rows().map((r) => toService(r, withSpark));

  function validate(s: ServiceInput) {
    const p = probeUrlProblem(s.probeUrl);
    if (p) throw Object.assign(new Error(p), { status: 400 });
    if (s.statusKind !== 'none') {
      const q = probeUrlProblem(s.statusUrl ?? '');
      if (q) throw Object.assign(new Error(`status_${q}`), { status: 400 });
    }
  }
  function add(s: ServiceInput): Service {
    if ((db.prepare('SELECT COUNT(*) n FROM ott_services').get() as { n: number }).n >= MAX_SERVICES) throw Object.assign(new Error('too_many_services'), { status: 400 });
    validate(s);
    const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 n FROM ott_services').get() as { n: number }).n;
    const id = Number(insert(s, sort).lastInsertRowid);
    return toService(db.prepare('SELECT * FROM ott_services WHERE id = ?').get(id) as Row, false);
  }
  function update(id: number, s: ServiceInput): Service | null {
    validate(s);
    const r = db
      .prepare("UPDATE ott_services SET name = ?, category = ?, probe_url = ?, status_kind = ?, status_url = ?, enabled = ?, official = CASE WHEN ? = 'none' THEN 'sconosciuto' ELSE official END WHERE id = ?")
      .run(s.name.trim(), s.category, s.probeUrl.trim(), s.statusKind, (s.statusUrl ?? '').trim().replace(/\/+$/, ''), s.enabled === false ? 0 : 1, s.statusKind, id);
    return r.changes ? toService(db.prepare('SELECT * FROM ott_services WHERE id = ?').get(id) as Row, false) : null;
  }
  const remove = (id: number) => db.prepare('DELETE FROM ott_services WHERE id = ?').run(id).changes > 0;

  /** One probe as a customer: the time to the first answer; any HTTP answer below 500 is «reachable». */
  async function probe(url: string): Promise<{ ok: boolean; ms: number | null; code: string }> {
    const t0 = performance.now();
    try {
      const res = await f(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (cdanet-ott-monitor/1.0)', accept: 'text/html,*/*' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const ms = Math.round(performance.now() - t0);
      void res.body?.cancel().catch(() => {});
      return res.status < 500 ? { ok: true, ms, code: String(res.status) } : { ok: false, ms, code: String(res.status) };
    } catch (e) {
      const m = (e as Error).name === 'TimeoutError' ? 'timeout' : ((e as Error).message || 'errore').slice(0, 60);
      return { ok: false, ms: null, code: m };
    }
  }

  async function official(r: Row): Promise<{ official: Official; text: string }> {
    const url = r.status_kind === 'statuspage' ? `${r.status_url}/api/v2/summary.json` : r.status_url;
    try {
      const res = await f(url, { headers: { accept: 'application/json', 'user-agent': 'cdanet-ott-monitor/1.0' }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (!res.ok) return { official: 'sconosciuto', text: `pagina di stato HTTP ${res.status}` };
      const body = await res.json();
      return r.status_kind === 'statuspage' ? readStatuspage(body) : readGoogle(body);
    } catch (e) {
      return { official: 'sconosciuto', text: `pagina di stato non raggiungibile (${((e as Error).message || '').slice(0, 60)})` };
    }
  }

  /** One round: every enabled service probed (in parallel, 8 at a time); the official pages if asked. */
  async function roundNow(withOfficial: boolean) {
    const list = rows().filter((r) => r.enabled);
    const at = now().toISOString();
    const sample = db.prepare('INSERT INTO ott_samples(service_id, at, ok, ms, code) VALUES(?,?,?,?,?)');
    const recentQ = db.prepare('SELECT ok, ms FROM ott_samples WHERE service_id = ? ORDER BY at DESC LIMIT 6');
    const baseQ = db.prepare('SELECT ms FROM ott_samples WHERE service_id = ? AND ok = 1 AND at >= ? ORDER BY at DESC LIMIT 500');
    const changes: Array<{ r: Row; from: OttState; to: OttState }> = [];
    const offChanges: Array<{ r: Row; official: Official; text: string }> = [];
    const day = new Date(now().getTime() - 24 * 3600_000).toISOString();
    let i = 0;
    const work = async () => {
      while (i < list.length) {
        const r = list[i++]!;
        const p = await probe(r.probe_url);
        sample.run(r.id, at, p.ok ? 1 : 0, p.ms, p.code);
        const recent = (recentQ.all(r.id) as Array<{ ok: number; ms: number | null }>).reverse().map((s) => ({ ok: !!s.ok, ms: s.ms }));
        const baseline = median((baseQ.all(r.id, day) as Array<{ ms: number }>).map((x) => x.ms));
        const state = stateOf(recent, baseline);
        let off: { official: Official; text: string } | null = null;
        if (withOfficial && r.status_kind !== 'none' && r.status_url) off = await official(r);
        db.prepare(
          `UPDATE ott_services SET state = ?, since = CASE WHEN state = ? THEN since ELSE ? END, last_ms = ?, baseline_ms = ?, checked_at = ?${off ? ', official = ?, official_text = ?' : ''} WHERE id = ?`,
        ).run(...([state, state, at, p.ms, baseline, at, ...(off ? [off.official, off.text] : []), r.id] as Array<string | number | null>));
        if (r.state !== state && r.state !== 'sconosciuto' && state !== 'sconosciuto') changes.push({ r, from: r.state, to: state });
        if (off && r.official !== off.official && r.official !== 'sconosciuto' && off.official !== 'sconosciuto' && (off.official === 'major' || r.official === 'major')) offChanges.push({ r, official: off.official, text: off.text });
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, list.length) }, work));
    db.prepare('DELETE FROM ott_samples WHERE at < ?').run(new Date(now().getTime() - KEEP_HOURS * 3600_000).toISOString());
    db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('ott.last', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(at, at);
    if (opts.isOn()) send(changes, offChanges, list.length);
  }

  /** Our exit: over half of the services unreachable together. */
  function outage(): { ours: boolean; down: number; total: number } {
    const r = rows().filter((x) => x.enabled);
    const down = r.filter((x) => x.state === 'irraggiungibile').length;
    return { ours: r.length >= 4 && down / r.length > 0.5, down, total: r.length };
  }

  function send(changes: Array<{ r: Row; from: OttState; to: OttState }>, offChanges: Array<{ r: Row; official: Official; text: string }>, total: number) {
    const o = outage();
    if (o.ours && !lastOutage) {
      opts.notice(`🌐 ${o.down} servizi su ${total} irraggiungibili insieme`, ['Probabile problema sulla NOSTRA uscita verso Internet (transito, DNS, router di bordo), non dei servizi.', 'Controllare i fornitori di transito e il router di bordo.']);
      opts.group?.(`🌐 <b>${o.down} servizi su ${total} irraggiungibili insieme</b>: probabile problema sulla nostra uscita verso Internet.`);
    }
    if (!o.ours && lastOutage) {
      opts.notice('🌐 Uscita verso Internet tornata normale', [`Servizi irraggiungibili ora: ${o.down} su ${total}.`]);
      opts.group?.('🌐 Uscita verso Internet tornata normale.');
    }
    lastOutage = o.ours;
    if (o.ours) return; // one notice for all, not one per service
    for (const c of changes.slice(0, 10)) {
      const what = c.to === 'irraggiungibile' ? 'non raggiungibile dalla nostra rete' : c.to === 'lento' ? 'molto lento dalla nostra rete' : 'di nuovo normale';
      const extra = c.r.official_text ? [`Pagina di stato: ${c.r.official_text}`] : [];
      opts.notice(`📺 ${c.r.name}: ${what}`, [`${c.r.name} è ${what}.`, ...extra, 'Se i clienti segnalano problemi solo su questo servizio, è probabile che sia un guasto loro.']);
      opts.group?.(`📺 <b>${esc(c.r.name)}</b>: ${what}`);
    }
    for (const c of offChanges.slice(0, 10)) {
      const bad = c.official === 'major';
      opts.notice(`📢 ${c.r.name}: ${bad ? 'guasto grave dichiarato' : 'guasto risolto'}`, [bad ? `La pagina di stato ufficiale di ${c.r.name} segnala un guasto grave.` : `La pagina di stato ufficiale di ${c.r.name} non segnala più il guasto grave.`, ...(c.text ? [c.text] : [])]);
      opts.group?.(`📢 <b>${esc(c.r.name)}</b>: ${bad ? 'guasto grave dichiarato sulla pagina di stato' : 'guasto risolto'}${c.text ? `\n${esc(c.text)}` : ''}`);
    }
  }

  function round(withOfficial: boolean) {
    probing ??= roundNow(withOfficial)
      .catch((e) => opts.log?.(`servizi OTT: ${(e as Error).message}`))
      .finally(() => {
        probing = null;
      });
    return probing;
  }

  const lastAt = () => (db.prepare("SELECT value FROM settings WHERE key = 'ott.last'").get() as { value: string } | undefined)?.value ?? null;

  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  return {
    seed,
    list,
    add,
    update,
    remove,
    round,
    outage,
    lastAt,
    /** Every minute the probes, every 5 minutes also the official pages. */
    start(everyMs = 60_000) {
      seed();
      const tick = () => {
        if (!opts.isOn()) return;
        void round(ticks++ % 5 === 0);
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type OttMonitor = ReturnType<typeof createOttMonitor>;
