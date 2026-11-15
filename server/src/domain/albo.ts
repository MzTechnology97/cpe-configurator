import { createHash } from 'node:crypto';

/**
 * «Albo e permessi» (Carmelo, 15/11/2026): the acts of the online albo pretorio and the calls for
 * tenders («Bandi di gara e contratti» of Amministrazione trasparente) of the municipalities chosen
 * by the admins, kept only when they speak of networks: digs for fibre, antennas, radio stations,
 * telecommunications, connectivity. There is no national API or MCP for them: the municipalities
 * publish a list page, often with an RSS feed, and that is what is read here (pure part).
 */

export type AlboKind = 'albo' | 'bandi';
export const ALBO_KIND_LABEL: Record<AlboKind, string> = { albo: 'Albo pretorio', bandi: 'Bandi e contratti' };

/** One list of a municipality to read: its albo pretorio or its page of calls for tenders. */
export interface AlboSource {
  id: string;
  comune: string;
  kind: AlboKind;
  url: string;
  paused?: boolean;
}

export interface AlboConfig {
  sources: AlboSource[];
  keywords: Record<AlboKind, string[]>;
}

/**
 * Words that make an act worth a notification. Whole words only («tim» is not «timbro»), without
 * accents and case; a word of several words matches them in a row.
 */
export const DEFAULT_KEYWORDS: Record<AlboKind, string[]> = {
  albo: [
    'fibra',
    'fibra ottica',
    'banda ultra larga',
    'banda ultralarga',
    'scavo',
    'scavi',
    'minitrincea',
    'microtrincea',
    'infrastruttura di comunicazione elettronica',
    'comunicazioni elettroniche',
    'telecomunicazioni',
    'telefonia mobile',
    'stazione radio base',
    'srb',
    'impianto radioelettrico',
    'antenna',
    'antenne',
    'ripetitore',
    'traliccio',
    '5g',
    'open fiber',
    'fibercop',
    'infratel',
    'inwit',
    'tim',
    'vodafone',
    'wind tre',
    'windtre',
    'iliad',
    'eolo',
    'manomissione suolo pubblico',
    'occupazione suolo pubblico',
  ],
  bandi: [
    'connettivita',
    'connessione internet',
    'accesso a internet',
    'rete dati',
    'fibra',
    'fibra ottica',
    'banda ultra larga',
    'wifi',
    'wi fi',
    'hotspot',
    'ponte radio',
    'ponti radio',
    'telecomunicazioni',
    'telefonia',
    'centralino',
    'voip',
    'videosorveglianza',
    'cablaggio',
    'networking',
    'servizi di rete',
  ],
};

/** Lower case, no accents, only letters and digits separated by single spaces. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The keywords found in [text], as written in the list (whole words). */
export function matchKeywords(text: string, keywords: string[]): string[] {
  const t = ` ${normalize(text)} `;
  const out: string[] = [];
  for (const k of keywords) {
    const n = normalize(k);
    if (n && t.includes(` ${n} `) && !out.includes(k)) out.push(k);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', deg: '°' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const n = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** Text of an HTML fragment: no tags, scripts or styles, entities decoded, spaces collapsed. */
export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RawItem {
  title: string;
  url: string;
  publishedAt: string | null;
}

const tagText = (block: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? textOf(m[1]!) : null;
};

const isoDate = (s: string | null): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Whether [body] is an RSS or Atom feed rather than a web page. */
export function isFeed(body: string, contentType = ''): boolean {
  if (/xml|rss|atom/i.test(contentType) && !/html/i.test(contentType)) return true;
  const head = body.slice(0, 2000);
  return /<rss\b|<feed\b|<rdf:RDF\b/i.test(head);
}

/** The items of an RSS (2.0 or 1.0) or Atom feed. */
export function parseFeed(xml: string, base: string): RawItem[] {
  const out: RawItem[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2]!;
    const title = tagText(b, 'title') ?? '';
    const desc = tagText(b, 'description') ?? tagText(b, 'summary') ?? tagText(b, 'content') ?? '';
    let link = tagText(b, 'link') ?? '';
    if (!link) link = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(b)?.[1] ?? '';
    if (!link) link = tagText(b, 'guid') ?? '';
    const text = [title, desc && desc !== title ? desc : ''].filter(Boolean).join(' · ');
    if (!text) continue;
    out.push({ title: text.slice(0, 600), url: absolute(decodeEntities(link.trim()), base), publishedAt: isoDate(tagText(b, 'pubDate') ?? tagText(b, 'dc:date') ?? tagText(b, 'published') ?? tagText(b, 'updated')) });
  }
  return out;
}

const absolute = (href: string, base: string): string => {
  if (!href) return '';
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.toString() : '';
  } catch {
    return '';
  }
};

const USEFUL_HREF = (h: string) => !!h && !/^(javascript:|mailto:|tel:|#)/i.test(h.trim());

/**
 * The acts of a list page. The albo platforms show a table, one act per row, with the subject in a
 * cell and a «Visualizza» link: a row is one act (its whole text, its first link). Without a table,
 * every link with a long enough text.
 */
export function parsePage(html: string, base: string): RawItem[] {
  const body = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
  const out: RawItem[] = [];
  const seen = new Set<string>();
  const add = (title: string, href: string) => {
    const url = absolute(decodeEntities(href), base);
    const t = title.slice(0, 600);
    const key = `${url}|${t}`;
    if (t.length < 15 || seen.has(key)) return;
    seen.add(key);
    out.push({ title: t, url, publishedAt: null });
  };
  for (const m of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1]!;
    if (/<th\b/i.test(row)) continue;
    const href = [...row.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)].map((x) => x[1]!).find(USEFUL_HREF);
    // the subject without the short labels of the buttons («Visualizza», «stampa», «PDF»)
    if (href) add(textOf(row.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (a, t: string) => (textOf(t).length < 15 ? ' ' : a))), href);
  }
  if (out.length) return out;
  for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (USEFUL_HREF(m[1]!)) add(textOf(m[2]!), m[1]!);
  }
  return out;
}

/** Stable id of an act of a source: the same act read again is not new. */
export function itemId(sourceId: string, it: Pick<RawItem, 'title' | 'url'>): string {
  return createHash('sha256').update(`${sourceId}\n${it.url}\n${normalize(it.title)}`).digest('hex').slice(0, 32);
}

/**
 * Why [url] cannot be read as a source, or null. Only http(s) on a public name or address, without
 * credentials (the server checks again every address it connects to).
 */
export function sourceUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'url_invalid';
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return 'url_invalid';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return 'url_not_public';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return 'url_not_public';
  return null;
}

/** The charset of a response: from its header, else from the page, else UTF-8. */
export function charsetOf(contentType: string, head: string): string {
  const c = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1] ?? 'utf-8';
  return c.toLowerCase();
}
