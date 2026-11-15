import { randomBytes } from 'node:crypto';
import { nowIso, type Db } from '../db.ts';
import {
  ALBO_KIND_LABEL,
  type AlboConfig,
  type AlboKind,
  type AlboSource,
  charsetOf,
  DEFAULT_KEYWORDS,
  isFeed,
  itemId,
  matchKeywords,
  parseFeed,
  parsePage,
  type RawItem,
  sourceUrlProblem,
} from '../domain/albo.ts';
import { publicFetch } from '../net/public-fetch.ts';

/** At most this many lists, read once an hour. */
export const MAX_SOURCES = 80;
/** A list page or feed larger than this is cut (the newest acts come first). */
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** Notifications of one check: above, a single summary. */
const MAX_NOTICES = 12;

export interface SourceState {
  at: string;
  ok: boolean;
  error?: string;
  format?: 'feed' | 'pagina';
  items?: number;
  matched?: number;
  /** First good reading: the acts already there are kept without notifications. */
  baselineAt?: string;
}

export interface AlboItem {
  id: string;
  sourceId: string;
  comune: string;
  kind: AlboKind;
  title: string;
  url: string;
  publishedAt: string | null;
  keywords: string[];
  firstSeen: string;
  notified: boolean;
}

export interface Preview {
  format: 'feed' | 'pagina';
  total: number;
  items: Array<RawItem & { keywords: string[] }>;
}

const DEFAULT_CONFIG: AlboConfig = { sources: [], keywords: DEFAULT_KEYWORDS };

export function createAlbo(
  db: Db,
  opts: {
    fetchImpl?: typeof fetch;
    isOn: () => boolean;
    /** To the NOC: the page Notifiche of every admin (and their Telegram, if they chose it). */
    notice: (title: string, lines: string[]) => void;
    /** To the NOC group on Telegram (HTML). */
    group?: (html: string) => void;
    escape?: (s: string) => string;
    log?: (m: string) => void;
  },
) {
  const f = opts.fetchImpl ?? publicFetch();
  const esc = opts.escape ?? ((s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  type Run = { at: string; ok: boolean; error?: string; sources: number; fresh: number };
  let lastRun: Run | null = null;
  let running: Promise<Run> | null = null;

  const readSetting = <T>(key: string, def: T): T => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as T) : def;
    } catch {
      return def;
    }
  };
  const writeSetting = (key: string, value: unknown, userId: number | null) =>
    db
      .prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(key, JSON.stringify(value), nowIso(), userId);

  function config(): AlboConfig {
    const c = readSetting<Partial<AlboConfig>>('albo.config', {});
    return { sources: c.sources ?? DEFAULT_CONFIG.sources, keywords: { ...DEFAULT_CONFIG.keywords, ...(c.keywords ?? {}) } };
  }

  const states = () => readSetting<Record<string, SourceState>>('albo.state', {});
  const saveState = (id: string, s: SourceState) => writeSetting('albo.state', { ...states(), [id]: s }, null);

  /** Saves the lists and the words; a new list gets an id, a list removed loses its state. */
  function setConfig(c: { sources: Array<Omit<AlboSource, 'id'> & { id?: string }>; keywords: Record<AlboKind, string[]> }, userId: number): AlboConfig {
    if (c.sources.length > MAX_SOURCES) throw Object.assign(new Error('too_many_sources'), { status: 400 });
    for (const s of c.sources) {
      const p = sourceUrlProblem(s.url);
      if (p) throw Object.assign(new Error(p), { status: 400, detail: s.url });
    }
    const old = config();
    const sources: AlboSource[] = c.sources.map((s) => {
      const id = s.id && old.sources.some((o) => o.id === s.id) ? s.id : randomBytes(6).toString('hex');
      // a list whose address changes starts again from its acts of today
      const prev = old.sources.find((o) => o.id === id);
      return { id: prev && prev.url !== s.url.trim() ? randomBytes(6).toString('hex') : id, comune: s.comune.trim(), kind: s.kind, url: s.url.trim(), ...(s.paused ? { paused: true } : {}) };
    });
    const keywords = Object.fromEntries((['albo', 'bandi'] as const).map((k) => [k, [...new Set(c.keywords[k].map((w) => w.trim()).filter(Boolean))].slice(0, 200)])) as Record<AlboKind, string[]>;
    const next = { sources, keywords };
    writeSetting('albo.config', next, userId);
    const keep = new Set(sources.map((s) => s.id));
    writeSetting('albo.state', Object.fromEntries(Object.entries(states()).filter(([id]) => keep.has(id))), null);
    return next;
  }

  /** Reads one list: its acts, as a feed or as a page. */
  async function read(url: string): Promise<{ format: 'feed' | 'pagina'; items: RawItem[] }> {
    const p = sourceUrlProblem(url);
    if (p) throw new Error(p);
    const res = await f(url, {
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; albo-monitor/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer()).slice(0, MAX_BYTES);
    const ct = res.headers.get('content-type') ?? '';
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4000));
    let body: string;
    try {
      body = new TextDecoder(charsetOf(ct, head)).decode(buf);
    } catch {
      body = new TextDecoder('utf-8').decode(buf);
    }
    const base = res.url || url;
    return isFeed(body, ct) ? { format: 'feed', items: parseFeed(body, base) } : { format: 'pagina', items: parsePage(body, base) };
  }

  /** Admin: what a list gives today, with the words found (before saving it). */
  async function preview(url: string, kind: AlboKind): Promise<Preview> {
    const r = await read(url);
    const kw = config().keywords[kind];
    const items = r.items.map((i) => ({ ...i, keywords: matchKeywords(i.title, kw) }));
    return { format: r.format, total: items.length, items: [...items.filter((i) => i.keywords.length), ...items.filter((i) => !i.keywords.length)].slice(0, 40) };
  }

  /** One check of every list: new acts with the words of their kind are kept and notified. */
  async function refreshNow(): Promise<Run> {
    const c = config();
    const now = nowIso();
    const exists = db.prepare('SELECT 1 FROM albo_items WHERE id = ?');
    const insert = db.prepare('INSERT INTO albo_items(id, source_id, comune, kind, title, url, published_at, keywords, first_seen, notified) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const fresh: AlboItem[] = [];
    let errors = 0;
    const active = c.sources.filter((s) => !s.paused);
    for (const s of active) {
      const prev = states()[s.id];
      try {
        const r = await read(s.url);
        const baseline = !prev?.baselineAt;
        let matched = 0;
        db.exec('BEGIN');
        try {
          for (const it of r.items) {
            const id = itemId(s.id, it);
            const keywords = matchKeywords(it.title, c.keywords[s.kind]);
            if (keywords.length) matched++;
            if (exists.get(id)) continue;
            const notify = !baseline && keywords.length > 0;
            insert.run(id, s.id, s.comune, s.kind, it.title, it.url, it.publishedAt, keywords.join('|'), now, notify ? 1 : 0);
            if (notify) fresh.push({ id, sourceId: s.id, comune: s.comune, kind: s.kind, title: it.title, url: it.url, publishedAt: it.publishedAt, keywords, firstSeen: now, notified: true });
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        saveState(s.id, { at: now, ok: true, format: r.format, items: r.items.length, matched, baselineAt: prev?.baselineAt ?? now });
      } catch (err) {
        errors++;
        saveState(s.id, { ...(prev ?? {}), at: now, ok: false, error: (err as Error).message.slice(0, 200) });
        opts.log?.(`albo ${s.comune}: ${(err as Error).message}`);
      }
    }
    if (opts.isOn()) send(fresh);
    // acts without the words are kept 90 days (only to know they are not new), the others a year
    db.prepare("DELETE FROM albo_items WHERE (keywords = '' AND first_seen < ?) OR first_seen < ?").run(new Date(Date.now() - 90 * 86400_000).toISOString(), new Date(Date.now() - 365 * 86400_000).toISOString());
    const run: Run = { at: now, ok: errors === 0, ...(errors ? { error: `${errors} elenchi non letti su ${active.length}` } : {}), sources: active.length, fresh: fresh.length };
    lastRun = run;
    return run;
  }

  function send(fresh: AlboItem[]) {
    for (const it of fresh.slice(0, MAX_NOTICES)) {
      const title = `📜 ${it.comune} · ${ALBO_KIND_LABEL[it.kind]}`;
      const lines = [it.title, ...(it.url ? [it.url] : []), `Parole: ${it.keywords.join(', ')}`];
      opts.notice(title, lines);
      opts.group?.(`📜 <b>${esc(it.comune)}</b> · ${esc(ALBO_KIND_LABEL[it.kind])}\n${esc(it.title)}${it.url ? `\n<a href="${esc(it.url)}">apri l’atto</a>` : ''}\n<i>${esc(it.keywords.join(', '))}</i>`);
    }
    if (fresh.length > MAX_NOTICES) {
      const rest = fresh.length - MAX_NOTICES;
      const comuni = [...new Set(fresh.slice(MAX_NOTICES).map((i) => i.comune))].join(', ');
      opts.notice(`📜 Altri ${rest} atti su reti e bandi`, [`Comuni: ${comuni}`, 'Sono tutti nella pagina Albo e permessi.']);
      opts.group?.(`📜 Altri ${rest} atti su reti e bandi (${esc(comuni)}): sono nella pagina Albo e permessi.`);
    }
  }

  /** A check at a time: a second request waits for the one running. */
  function refresh() {
    running ??= refreshNow().finally(() => {
      running = null;
    });
    return running;
  }

  /** The acts with the words, newest first. */
  function items(o: { limit?: number; comune?: string; kind?: AlboKind } = {}): AlboItem[] {
    const where = ["keywords <> ''"];
    const args: Array<string | number> = [];
    if (o.comune) (where.push('comune = ?'), args.push(o.comune));
    if (o.kind) (where.push('kind = ?'), args.push(o.kind));
    const rows = db
      .prepare(`SELECT id, source_id sourceId, comune, kind, title, url, published_at publishedAt, keywords, first_seen firstSeen, notified FROM albo_items WHERE ${where.join(' AND ')} ORDER BY first_seen DESC, rowid DESC LIMIT ?`)
      .all(...args, o.limit ?? 200) as Array<Omit<AlboItem, 'keywords' | 'notified'> & { keywords: string; notified: number }>;
    return rows.map((r) => ({ ...r, keywords: r.keywords.split('|').filter(Boolean), notified: !!r.notified }));
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    config,
    setConfig,
    states,
    preview,
    refresh,
    items,
    status: () => lastRun,
    start(everyMs = 60 * 60_000) {
      const tick = () => {
        if (opts.isOn() && config().sources.length) void refresh();
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
      setTimeout(tick, 90_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type Albo = ReturnType<typeof createAlbo>;
