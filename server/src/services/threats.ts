import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { nowIso, type Db } from '../db.ts';
import { publicFetch } from '../net/public-fetch.ts';

/**
 * «Minacce» (module threats, Carmelo 15/11/2026, perimeter NIS2): the assets of CDA Net and of its
 * suppliers (systems, services) with their domains, IPs and emails, checked once a day against
 * ransomware.live (PRO API, key in the server's .env only):
 * - victims: is a domain or the name of an asset (ours or a supplier's) among the victims the
 *   ransomware groups publish? Only the domain or the name goes out, never an IP or an email;
 * - indicators: the IPs, domains and emails of the groups (IOC) are downloaded and compared here,
 *   so our IPs and emails never leave the server.
 * Passwords are never kept: they are checked once, when written, against the lists of stolen
 * passwords (Have I Been Pwned, k-anonymity: only the first 5 characters of the SHA-1 go out), and
 * only the result is kept (label, how many times seen, when).
 */

export const ASSET_KINDS = ['sistema', 'servizio', 'dominio', 'fornitore', 'altro'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const MAX_ASSETS = 200;
export const MAX_INDICATORS = 50;
const TIMEOUT_MS = 20_000;
/** Notifications of one check: above, a single summary. */
const MAX_NOTICES = 10;

export interface Asset {
  id: number;
  name: string;
  kind: AssetKind;
  /** The name is searched among the victims too (a supplier, our company): short names are not. */
  searchName: boolean;
  domains: string[];
  ips: string[];
  emails: string[];
  notes: string;
  updatedAt: string;
}

export interface AssetInput {
  name: string;
  kind: AssetKind;
  searchName?: boolean;
  domains: string[];
  ips: string[];
  emails: string[];
  notes?: string;
}

export interface Hit {
  id: string;
  assetId: number;
  assetName: string;
  source: 'victim' | 'ioc';
  indicator: string;
  title: string;
  group: string;
  url: string;
  publishedAt: string | null;
  firstSeen: string;
}

export interface PasswordCheck {
  id: number;
  assetId: number;
  label: string;
  /** How many times the password is in the stolen lists (0: not found). */
  seen: number;
  checkedAt: string;
}

export type Run = { at: string; ok: boolean; error?: string; assets: number; calls: number; fresh: number };

// ---- pure helpers (tested) -----------------------------------------------------------------------

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@<>"']{1,64}@([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** Cleans the indicators of an asset: lowercase, valid, no repeats; the wrong ones are said by name. */
export function cleanIndicators(i: { domains: string[]; ips: string[]; emails: string[] }): { domains: string[]; ips: string[]; emails: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const uniq = (list: string[], ok: (s: string) => boolean, norm: (s: string) => string) => {
    const out: string[] = [];
    for (const raw of list) {
      const s = norm(raw.trim());
      if (!s) continue;
      if (!ok(s)) invalid.push(raw.trim());
      else if (!out.includes(s)) out.push(s);
    }
    return out.slice(0, MAX_INDICATORS);
  };
  const host = (s: string) => s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return {
    domains: uniq(i.domains, (s) => DOMAIN.test(s), host),
    ips: uniq(i.ips, (s) => isIP(s) !== 0, (s) => s.toLowerCase()),
    emails: uniq(i.emails, (s) => EMAIL.test(s), (s) => s.toLowerCase()),
    invalid,
  };
}

/** Every string inside a JSON answer (the shape of the IOC lists changes from group to group). */
export function stringsOf(v: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || out.size > 200_000) return out;
  if (typeof v === 'string') out.add(v.trim().toLowerCase());
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out, depth + 1);
  return out;
}

/** One victim of an answer, whatever the names of its fields (legacy and current API). */
export function victimOf(v: Record<string, unknown>): { title: string; group: string; website: string; url: string; publishedAt: string | null } {
  const s = (...keys: string[]) => {
    for (const k of keys) if (typeof v[k] === 'string' && (v[k] as string).trim()) return (v[k] as string).trim();
    return '';
  };
  return {
    title: s('victim', 'post_title', 'name', 'title'),
    group: s('group', 'group_name'),
    website: s('website', 'domain', 'url').toLowerCase(),
    url: s('permalink', 'post_url', 'link'),
    publishedAt: s('attackdate', 'published', 'discovered', 'date') || null,
  };
}

/** The list of victims in an answer: an array, or the array under victims/data/results. */
export function victimsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  if (body && typeof body === 'object') {
    for (const k of ['victims', 'data', 'results', 'items']) {
      const v = (body as Record<string, unknown>)[k];
      if (Array.isArray(v)) return victimsOf(v);
    }
  }
  return [];
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();

/** Does a victim match what we searched? The domain in its site or title, or the whole name as words. */
export function victimMatches(v: { title: string; website: string }, term: { domain?: string; name?: string }): boolean {
  if (term.domain) {
    const d = term.domain.toLowerCase();
    const site = v.website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    return site === d || site.endsWith(`.${d}`) || norm(v.title).split(' ').includes(d);
  }
  if (term.name) {
    const n = norm(term.name);
    return n.length >= 4 && ` ${norm(v.title)} `.includes(` ${n} `);
  }
  return false;
}

export const hitId = (assetId: number, source: string, indicator: string, ref: string) => createHash('sha256').update(`${assetId}|${source}|${indicator}|${ref}`).digest('hex').slice(0, 32);

/** k-anonymity: the first 5 characters of the SHA-1 go out, the rest is compared here. */
export function pwnedSplit(password: string): { prefix: string; suffix: string } {
  const h = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  return { prefix: h.slice(0, 5), suffix: h.slice(5) };
}

/** How many times the suffix is in the range answer («SUFFIX:COUNT» per line; padding lines count 0). */
export function pwnedCount(rangeBody: string, suffix: string): number {
  for (const line of rangeBody.split(/\r?\n/)) {
    const [s, c] = line.trim().split(':');
    if (s?.toUpperCase() === suffix) return Number(c) || 0;
  }
  return 0;
}

// ---- service -------------------------------------------------------------------------------------

type Row = { id: number; name: string; kind: AssetKind; search_name: number; domains: string; ips: string; emails: string; notes: string; updated_at: string };

export function createThreats(
  db: Db,
  opts: {
    apiKey: () => string | undefined;
    baseUrl?: string;
    pwnedUrl?: string;
    fetchImpl?: typeof fetch;
    isOn: () => boolean;
    /** To the NOC: the page Notifiche of every admin (and their Telegram, if they chose it). */
    notice: (title: string, lines: string[]) => void;
    /** To the NOC group on Telegram (HTML). */
    group?: (html: string) => void;
    escape?: (s: string) => string;
    log?: (m: string) => void;
    /** Pause between two calls to the API (fair use). */
    pauseMs?: number;
  },
) {
  const f = opts.fetchImpl ?? publicFetch();
  const base = (opts.baseUrl ?? 'https://api-pro.ransomware.live').replace(/\/+$/, '');
  const pwned = (opts.pwnedUrl ?? 'https://api.pwnedpasswords.com').replace(/\/+$/, '');
  const esc = opts.escape ?? ((s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const pause = opts.pauseMs ?? 300;
  let lastRun: Run | null = null;
  let running: Promise<Run> | null = null;

  const toAsset = (r: Row): Asset => ({ id: r.id, name: r.name, kind: r.kind, searchName: !!r.search_name, domains: JSON.parse(r.domains), ips: JSON.parse(r.ips), emails: JSON.parse(r.emails), notes: r.notes, updatedAt: r.updated_at });
  const assets = (): Asset[] => (db.prepare('SELECT * FROM threat_assets ORDER BY name COLLATE NOCASE').all() as Row[]).map(toAsset);

  function validate(a: AssetInput) {
    const c = cleanIndicators(a);
    if (c.invalid.length) throw Object.assign(new Error('invalid_indicators'), { status: 400, detail: c.invalid.slice(0, 10) });
    return c;
  }

  function addAsset(a: AssetInput, userId: number): Asset {
    if ((db.prepare('SELECT COUNT(*) n FROM threat_assets').get() as { n: number }).n >= MAX_ASSETS) throw Object.assign(new Error('too_many_assets'), { status: 400 });
    const c = validate(a);
    const r = db
      .prepare('INSERT INTO threat_assets(name, kind, search_name, domains, ips, emails, notes, created_at, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(a.name.trim(), a.kind, a.searchName ? 1 : 0, JSON.stringify(c.domains), JSON.stringify(c.ips), JSON.stringify(c.emails), (a.notes ?? '').trim(), nowIso(), nowIso(), userId);
    return toAsset(db.prepare('SELECT * FROM threat_assets WHERE id = ?').get(Number(r.lastInsertRowid)) as Row);
  }

  function updateAsset(id: number, a: AssetInput, userId: number): Asset | null {
    const c = validate(a);
    const r = db
      .prepare('UPDATE threat_assets SET name = ?, kind = ?, search_name = ?, domains = ?, ips = ?, emails = ?, notes = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(a.name.trim(), a.kind, a.searchName ? 1 : 0, JSON.stringify(c.domains), JSON.stringify(c.ips), JSON.stringify(c.emails), (a.notes ?? '').trim(), nowIso(), userId, id);
    return r.changes ? toAsset(db.prepare('SELECT * FROM threat_assets WHERE id = ?').get(id) as Row) : null;
  }

  const removeAsset = (id: number) => db.prepare('DELETE FROM threat_assets WHERE id = ?').run(id).changes > 0;

  async function api(path: string): Promise<unknown> {
    const key = opts.apiKey();
    if (!key) throw new Error('ransomware_live_key_missing');
    const res = await f(`${base}${path}`, { headers: { 'X-API-KEY': key, accept: 'application/json', 'user-agent': 'cdanet-cpe-threats/1.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) throw new Error('ransomware_live_key_refused');
    if (res.status === 429) throw new Error('ransomware_live_quota');
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`ransomware.live HTTP ${res.status}`);
    return res.json();
  }
  const wait = () => (pause ? new Promise((r) => setTimeout(r, pause)) : Promise.resolve());

  /** One check of every asset: new hits are kept and notified. */
  async function refreshNow(): Promise<Run> {
    const list = assets();
    const now = nowIso();
    const exists = db.prepare('SELECT 1 FROM threat_hits WHERE id = ?');
    const insert = db.prepare('INSERT INTO threat_hits(id, asset_id, source, indicator, title, group_name, url, published_at, first_seen) VALUES(?,?,?,?,?,?,?,?,?)');
    const fresh: Hit[] = [];
    let calls = 0;
    let errors = 0;
    let firstError = '';
    const keep = (h: Omit<Hit, 'id' | 'firstSeen'>, ref: string) => {
      const id = hitId(h.assetId, h.source, h.indicator, ref);
      if (exists.get(id)) return;
      insert.run(id, h.assetId, h.source, h.indicator, h.title, h.group, h.url, h.publishedAt, now);
      fresh.push({ ...h, id, firstSeen: now });
    };
    const fail = (e: unknown) => {
      errors++;
      firstError ||= (e as Error).message;
      opts.log?.(`minacce: ${(e as Error).message}`);
    };

    // victims: the domains and the names to search (only these go out)
    for (const a of list) {
      const terms: Array<{ q: string; domain?: string; name?: string }> = [...a.domains.map((d) => ({ q: d, domain: d })), ...(a.searchName && a.name.trim().length >= 4 ? [{ q: a.name.trim(), name: a.name.trim() }] : [])];
      for (const t of terms) {
        try {
          calls++;
          const body = await api(`/victims/search?q=${encodeURIComponent(t.q)}`);
          for (const raw of victimsOf(body)) {
            const v = victimOf(raw);
            if (!victimMatches(v, t)) continue;
            keep({ assetId: a.id, assetName: a.name, source: 'victim', indicator: t.q, title: v.title || v.website, group: v.group, url: v.url, publishedAt: v.publishedAt }, `${v.group}|${v.title}|${v.publishedAt ?? ''}`);
          }
        } catch (e) {
          fail(e);
          if (/key_missing|key_refused|quota/.test((e as Error).message)) return finish();
        }
        await wait();
      }
    }

    // indicators of the groups: downloaded and compared here (our IPs and emails never go out)
    const ours = new Map<string, Asset[]>();
    for (const a of list) for (const x of [...a.ips, ...a.domains, ...a.emails]) ours.set(x, [...(ours.get(x) ?? []), a]);
    if (ours.size) {
      try {
        calls++;
        const groups = await api('/iocs');
        const names = [...new Set((Array.isArray(groups) ? groups : victimsOf(groups).length ? victimsOf(groups) : Object.keys((groups as object) ?? {})).map((g) => (typeof g === 'string' ? g : String((g as Record<string, unknown>).group ?? (g as Record<string, unknown>).name ?? ''))).filter(Boolean))];
        for (const g of names.slice(0, 400)) {
          await wait();
          try {
            calls++;
            const found = stringsOf(await api(`/iocs/${encodeURIComponent(g)}`));
            for (const [ind, owners] of ours) {
              if (!found.has(ind)) continue;
              for (const a of owners) keep({ assetId: a.id, assetName: a.name, source: 'ioc', indicator: ind, title: `Indicatore del gruppo ${g}`, group: g, url: '', publishedAt: null }, g);
            }
          } catch (e) {
            fail(e);
            if (/key_refused|quota/.test((e as Error).message)) break;
          }
        }
      } catch (e) {
        fail(e);
      }
    }
    return finish();

    function finish(): Run {
      if (opts.isOn()) send(fresh);
      const run: Run = { at: now, ok: errors === 0, ...(errors ? { error: `${errors} letture non riuscite${firstError ? ` (${firstError})` : ''}` } : {}), assets: list.length, calls, fresh: fresh.length };
      lastRun = run;
      db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('threats.last', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(run), now);
      return run;
    }
  }

  function send(fresh: Hit[]) {
    const what = (h: Hit) => (h.source === 'victim' ? `tra le vittime del gruppo ${h.group || '?'}` : `negli indicatori del gruppo ${h.group}`);
    for (const h of fresh.slice(0, MAX_NOTICES)) {
      opts.notice(`🛡️ ${h.assetName}: ${h.indicator}`, [`${h.indicator} compare ${what(h)}.`, ...(h.title ? [h.title] : []), ...(h.url ? [h.url] : []), 'Fonte: ransomware.live. Verificare e, se confermato, valutare la notifica al CSIRT (NIS2).']);
      opts.group?.(`🛡️ <b>${esc(h.assetName)}</b>: ${esc(h.indicator)} compare ${esc(what(h))}${h.title ? `\n${esc(h.title)}` : ''}${h.url ? `\n<a href="${esc(h.url)}">apri</a>` : ''}`);
    }
    if (fresh.length > MAX_NOTICES) {
      const rest = fresh.length - MAX_NOTICES;
      opts.notice(`🛡️ Altri ${rest} riscontri su ransomware.live`, ['Sono tutti nella pagina Minacce della console.']);
      opts.group?.(`🛡️ Altri ${rest} riscontri su ransomware.live: sono nella pagina Minacce.`);
    }
  }

  /** A check at a time: a second request waits for the one running. */
  function refresh() {
    running ??= refreshNow().finally(() => {
      running = null;
    });
    return running;
  }

  function hits(limit = 300): Hit[] {
    return db
      .prepare(
        `SELECT h.id, h.asset_id assetId, a.name assetName, h.source, h.indicator, h.title, h.group_name "group", h.url, h.published_at publishedAt, h.first_seen firstSeen
           FROM threat_hits h JOIN threat_assets a ON a.id = h.asset_id ORDER BY h.first_seen DESC, h.rowid DESC LIMIT ?`,
      )
      .all(limit) as unknown as Hit[];
  }

  /** The password checked and forgotten: only the label and the result are kept. */
  async function checkPassword(assetId: number, label: string, password: string): Promise<PasswordCheck> {
    if (!db.prepare('SELECT 1 FROM threat_assets WHERE id = ?').get(assetId)) throw Object.assign(new Error('asset_not_found'), { status: 404 });
    const { prefix, suffix } = pwnedSplit(password);
    const res = await f(`${pwned}/range/${prefix}`, { headers: { 'Add-Padding': 'true', 'user-agent': 'cdanet-cpe-threats/1.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw Object.assign(new Error(`pwned_passwords_http_${res.status}`), { status: 502 });
    const seen = pwnedCount(await res.text(), suffix);
    const at = nowIso();
    const r = db.prepare('INSERT INTO threat_password_checks(asset_id, label, seen, checked_at) VALUES(?,?,?,?)').run(assetId, label.trim(), seen, at);
    return { id: Number(r.lastInsertRowid), assetId, label: label.trim(), seen, checkedAt: at };
  }

  const passwordChecks = (): PasswordCheck[] =>
    db.prepare('SELECT id, asset_id assetId, label, seen, checked_at checkedAt FROM threat_password_checks ORDER BY checked_at DESC LIMIT 500').all() as unknown as PasswordCheck[];

  const status = (): Run | null => {
    if (lastRun) return lastRun;
    const r = db.prepare("SELECT value FROM settings WHERE key = 'threats.last'").get() as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as Run) : null;
    } catch {
      return null;
    }
  };

  let timer: NodeJS.Timeout | null = null;
  return {
    assets,
    addAsset,
    updateAsset,
    removeAsset,
    refresh,
    hits,
    checkPassword,
    passwordChecks,
    status,
    configured: () => !!opts.apiKey(),
    start(everyMs = 24 * 60 * 60_000) {
      const tick = () => {
        if (opts.isOn() && opts.apiKey() && assets().length) void refresh();
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
      setTimeout(tick, 5 * 60_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type Threats = ReturnType<typeof createThreats>;
