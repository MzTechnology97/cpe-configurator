import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { nowIso, type Db } from '../db.ts';
import { publicFetch } from '../net/public-fetch.ts';

/**
 * «Antenne altri operatori» (module operator_sites, Carmelo 15/11/2026): where the other operators'
 * base stations (BTS) are, on a map, for the staff.
 *
 * - From open data: OpenCelliD (CC BY-SA 4.0, a free token in the .env), the cells of Italy
 *   (MCC 222) of the networks chosen (default WindTre, MNC 88 and 99, the network of OpNet) inside a
 *   box (default Sicily). The positions are estimated from the phones' measurements: the cells
 *   within ~150 m are grouped in one «estimated site».
 * - By hand: the admins add the sites they know (for example Eolo, which doesn't publish its BTS),
 *   marked «da confermare» or «confermata».
 * The downloaded data stay in the database of the server: never in the repository.
 */

export const SITE_STATUSES = ['stimata', 'da confermare', 'confermata'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];
export const MAX_MANUAL_SITES = 2000;
/** The most sites a map request returns (the rest: zoom in). */
export const MAX_SITES_PER_VIEW = 4000;
/** ~150 m: the cells closer than this are one site. */
const GRID_DEG = 0.0015;
const GRID_M = 150;
const TIMEOUT_MS = 10 * 60_000;

export interface Site {
  id: number;
  operator: string;
  source: 'opencellid' | 'manuale';
  lat: number;
  lon: number;
  /** GSM, UMTS, LTE, NR: what the cells of the site use. */
  radios: string[];
  cells: number;
  samples: number;
  /** The estimated reach of the widest cell, metres (OpenCelliD «range»). */
  rangeM: number;
  status: SiteStatus;
  note: string;
  updatedAt: string;
}
export interface SiteInput {
  operator: string;
  lat: number;
  lon: number;
  status: SiteStatus;
  note?: string;
  radios?: string[];
}
export type Bbox = { south: number; west: number; north: number; east: number };
export type ImportRun = { at: string; ok: boolean; error?: string; lines: number; cells: number; sites: number; seconds: number };

// ---- pure helpers (tested) -----------------------------------------------------------------------

/** «36.5,12.0,38.4,15.8» (south, west, north, east) → the box, or null if it's wrong. */
export function parseBbox(s: string): Bbox | null {
  const n = s.split(',').map((x) => Number(x.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [south, west, north, east] = n as [number, number, number, number];
  if (south >= north || west >= east || south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { south, west, north, east };
}

/** «88:WindTre,99:WindTre» → MNC → operator name. */
export function parseNets(s: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const part of s.split(',')) {
    const [code, ...name] = part.split(':');
    const n = Number(code?.trim());
    const label = name.join(':').trim();
    if (Number.isInteger(n) && n >= 0 && n < 1000 && label) m.set(n, label.slice(0, 40));
  }
  return m;
}

export type Cell = { operator: string; radio: string; lat: number; lon: number; range: number; samples: number };
const RADIOS = new Set(['GSM', 'UMTS', 'CDMA', 'LTE', 'NR']);

/**
 * One line of the OpenCelliD CSV (radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,
 * created,updated,averageSignal) → the cell, if it's of a network and a box we want.
 */
export function parseCellLine(line: string, mcc: number, nets: Map<number, string>, box: Bbox): Cell | null {
  const f = line.split(',');
  if (f.length < 10) return null;
  const radio = f[0]!.trim().toUpperCase();
  if (!RADIOS.has(radio)) return null;
  if (Number(f[1]) !== mcc) return null;
  const operator = nets.get(Number(f[2]));
  if (!operator) return null;
  const lon = Number(f[6]);
  const lat = Number(f[7]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < box.south || lat > box.north || lon < box.west || lon > box.east) return null;
  return { operator, radio, lat, lon, range: Math.max(0, Math.round(Number(f[8]) || 0)), samples: Math.max(0, Math.round(Number(f[9]) || 0)) };
}

type Acc = { operator: string; latSum: number; lonSum: number; w: number; radios: Set<string>; cells: number; samples: number; range: number };
type Groups = Map<string, Acc[]>;

/**
 * The cells grouped in estimated sites: a cell joins the site of the same operator whose centre is
 * within ~150 m (looked for in the squares around it), else starts one; the position is weighted by
 * the samples.
 */
export function groupSites(cells: Iterable<Cell>, acc: Groups = new Map()): Acc[] {
  for (const c of cells) addCell(acc, c);
  return [...acc.values()].flat();
}
const metres = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const dy = (lat2 - lat1) * 111_320;
  const dx = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
};
function addCell(acc: Groups, c: Cell) {
  const gx = Math.floor(c.lat / GRID_DEG);
  const gy = Math.floor(c.lon / GRID_DEG);
  let a: Acc | undefined;
  for (let i = -1; i <= 1 && !a; i++)
    for (let j = -1; j <= 1 && !a; j++)
      a = acc.get(`${c.operator}|${gx + i}|${gy + j}`)?.find((x) => metres(x.latSum / x.w, x.lonSum / x.w, c.lat, c.lon) <= GRID_M);
  if (!a) {
    a = { operator: c.operator, latSum: 0, lonSum: 0, w: 0, radios: new Set(), cells: 0, samples: 0, range: 0 };
    const key = `${c.operator}|${gx}|${gy}`;
    acc.set(key, [...(acc.get(key) ?? []), a]);
  }
  const w = Math.max(1, c.samples);
  a.latSum += c.lat * w;
  a.lonSum += c.lon * w;
  a.w += w;
  a.radios.add(c.radio);
  a.cells++;
  a.samples += c.samples;
  a.range = Math.max(a.range, c.range);
}
export const siteOf = (a: Acc) => ({ operator: a.operator, lat: Math.round((a.latSum / a.w) * 1e6) / 1e6, lon: Math.round((a.lonSum / a.w) * 1e6) / 1e6, radios: [...a.radios].sort(), cells: a.cells, samples: a.samples, rangeM: a.range });

// ---- service -------------------------------------------------------------------------------------

type Row = { id: number; operator: string; source: 'opencellid' | 'manuale'; lat: number; lon: number; radios: string; cells: number; samples: number; range_m: number; status: SiteStatus; note: string; updated_at: string };
const toSite = (r: Row): Site => ({ id: r.id, operator: r.operator, source: r.source, lat: r.lat, lon: r.lon, radios: r.radios ? r.radios.split(',') : [], cells: r.cells, samples: r.samples, rangeM: r.range_m, status: r.status, note: r.note, updatedAt: r.updated_at });

export function createOperatorSites(
  db: Db,
  opts: {
    token: () => string | undefined;
    url: string;
    mcc?: number;
    nets: string;
    bbox: string;
    fetchImpl?: typeof fetch;
    isOn: () => boolean;
    log?: (m: string) => void;
  },
) {
  const f = opts.fetchImpl ?? publicFetch();
  const mcc = opts.mcc ?? 222;
  let lastRun: ImportRun | null = null;
  let running: Promise<ImportRun> | null = null;

  const nets = () => parseNets(opts.nets);
  const box = () => parseBbox(opts.bbox);

  function list(view: Bbox | null, operators: string[] | null): { sites: Site[]; truncated: boolean } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (view) {
      where.push('lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?');
      args.push(view.south, view.north, view.west, view.east);
    }
    if (operators?.length) {
      where.push(`operator IN (${operators.map(() => '?').join(',')})`);
      args.push(...operators);
    }
    const rows = db
      .prepare(`SELECT * FROM operator_sites ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY source = 'manuale' DESC, cells DESC LIMIT ?`)
      .all(...args, MAX_SITES_PER_VIEW + 1) as Row[];
    return { sites: rows.slice(0, MAX_SITES_PER_VIEW).map(toSite), truncated: rows.length > MAX_SITES_PER_VIEW };
  }

  const summary = () =>
    db.prepare('SELECT operator, source, COUNT(*) sites, SUM(cells) cells FROM operator_sites GROUP BY operator, source ORDER BY operator COLLATE NOCASE, source').all() as Array<{ operator: string; source: string; sites: number; cells: number }>;

  const manual = (): Site[] => (db.prepare("SELECT * FROM operator_sites WHERE source = 'manuale' ORDER BY operator COLLATE NOCASE, id").all() as Row[]).map(toSite);

  function clean(s: SiteInput) {
    const radios = [...new Set((s.radios ?? []).map((r) => r.trim().toUpperCase()).filter((r) => RADIOS.has(r)))].sort();
    return { operator: s.operator.trim(), lat: Math.round(s.lat * 1e6) / 1e6, lon: Math.round(s.lon * 1e6) / 1e6, status: s.status, note: (s.note ?? '').trim(), radios: radios.join(',') };
  }

  function addManual(s: SiteInput, userId: number): Site {
    if ((db.prepare("SELECT COUNT(*) n FROM operator_sites WHERE source = 'manuale'").get() as { n: number }).n >= MAX_MANUAL_SITES) throw Object.assign(new Error('too_many_sites'), { status: 400 });
    const c = clean(s);
    const r = db
      .prepare("INSERT INTO operator_sites(operator, source, lat, lon, radios, cells, samples, range_m, status, note, updated_at, updated_by) VALUES(?, 'manuale', ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)")
      .run(c.operator, c.lat, c.lon, c.radios, c.status, c.note, nowIso(), userId);
    return toSite(db.prepare('SELECT * FROM operator_sites WHERE id = ?').get(Number(r.lastInsertRowid)) as Row);
  }

  function updateManual(id: number, s: SiteInput, userId: number): Site | null {
    const c = clean(s);
    const r = db
      .prepare("UPDATE operator_sites SET operator = ?, lat = ?, lon = ?, radios = ?, status = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ? AND source = 'manuale'")
      .run(c.operator, c.lat, c.lon, c.radios, c.status, c.note, nowIso(), userId, id);
    return r.changes ? toSite(db.prepare('SELECT * FROM operator_sites WHERE id = ?').get(id) as Row) : null;
  }

  const removeManual = (id: number) => db.prepare("DELETE FROM operator_sites WHERE id = ? AND source = 'manuale'").run(id).changes > 0;

  /** The download of OpenCelliD: streamed, filtered and grouped here; the old estimated sites replaced in one go. */
  async function importNow(): Promise<ImportRun> {
    const started = Date.now();
    const at = nowIso();
    let lines = 0;
    let cells = 0;
    const done = (r: Omit<ImportRun, 'at' | 'seconds'>): ImportRun => {
      const run: ImportRun = { at, seconds: Math.round((Date.now() - started) / 1000), ...r };
      lastRun = run;
      db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('operator_sites.last', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(run), at);
      if (!run.ok) opts.log?.(`antenne altri operatori: ${run.error}`);
      return run;
    };
    const token = opts.token();
    if (!token) return done({ ok: false, error: 'opencellid_token_missing', lines, cells, sites: 0 });
    const n = nets();
    const b = box();
    if (!n.size || !b) return done({ ok: false, error: 'opencellid_settings_invalid', lines, cells, sites: 0 });
    try {
      const u = new URL(opts.url);
      u.searchParams.set('token', token);
      u.searchParams.set('type', 'mcc');
      u.searchParams.set('file', `${mcc}.csv.gz`);
      const res = await f(String(u), { headers: { 'user-agent': 'cdanet-cpe-sites/1.0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok || !res.body) return done({ ok: false, error: `opencellid_http_${res.status}`, lines, cells, sites: 0 });
      // the errors come as short text with 200 (invalid token, daily limit): a gzip starts with 1f 8b
      const reader = res.body.getReader();
      const first = await reader.read();
      const head = first.value ?? new Uint8Array();
      if (head[0] !== 0x1f || head[1] !== 0x8b) {
        await reader.cancel().catch(() => {});
        const text = new TextDecoder().decode(head.slice(0, 200)).trim();
        const code = /RATE|LIMIT/i.test(text) ? 'opencellid_daily_limit' : /TOKEN|KEY|INVALID/i.test(text) ? 'opencellid_token_refused' : 'opencellid_not_gzip';
        return done({ ok: false, error: code, lines, cells, sites: 0 });
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(head);
        },
        async pull(c) {
          const r = await reader.read();
          if (r.done) c.close();
          else c.enqueue(r.value);
        },
        cancel: () => reader.cancel(),
      });
      const acc: Groups = new Map();
      const rl = createInterface({ input: Readable.fromWeb(body as import('node:stream/web').ReadableStream).pipe(createGunzip()), crlfDelay: Infinity });
      for await (const line of rl) {
        lines++;
        const c = parseCellLine(line, mcc, n, b);
        if (!c) continue;
        cells++;
        addCell(acc, c);
      }
      const sites = [...acc.values()].flat().map(siteOf);
      const insert = db.prepare("INSERT INTO operator_sites(operator, source, lat, lon, radios, cells, samples, range_m, status, note, updated_at) VALUES(?, 'opencellid', ?, ?, ?, ?, ?, ?, 'stimata', '', ?)");
      db.exec('BEGIN');
      try {
        db.prepare("DELETE FROM operator_sites WHERE source = 'opencellid'").run();
        for (const s of sites) insert.run(s.operator, s.lat, s.lon, s.radios.join(','), s.cells, s.samples, s.rangeM, at);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return done({ ok: true, lines, cells, sites: sites.length });
    } catch (e) {
      return done({ ok: false, error: (e as Error).message.slice(0, 200), lines, cells, sites: 0 });
    }
  }

  /** One import at a time: a second request waits for the one running. */
  function refresh() {
    running ??= importNow().finally(() => {
      running = null;
    });
    return running;
  }

  const status = (): ImportRun | null => {
    if (lastRun) return lastRun;
    const r = db.prepare("SELECT value FROM settings WHERE key = 'operator_sites.last'").get() as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as ImportRun) : null;
    } catch {
      return null;
    }
  };

  let timer: NodeJS.Timeout | null = null;
  return {
    list,
    summary,
    manual,
    addManual,
    updateManual,
    removeManual,
    refresh,
    status,
    running: () => running !== null,
    configured: () => !!opts.token(),
    settings: () => ({ mcc, nets: [...nets()].map(([mnc, operator]) => ({ mnc, operator })), bbox: box() }),
    /** Once a week (OpenCelliD allows a few downloads a day, and the data change slowly). */
    start(everyMs = 7 * 24 * 60 * 60_000) {
      const tick = () => {
        if (opts.isOn() && opts.token()) void refresh();
      };
      timer = setInterval(tick, everyMs);
      timer.unref();
      // the first time: 10 minutes after the start, if never imported
      setTimeout(() => {
        if (!status()) tick();
      }, 10 * 60_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
export type OperatorSites = ReturnType<typeof createOperatorSites>;
