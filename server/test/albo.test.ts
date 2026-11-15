import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { charsetOf, DEFAULT_KEYWORDS, isFeed, itemId, matchKeywords, parseFeed, parsePage, sourceUrlProblem } from '../src/domain/albo.ts';
import { ADMIN, testConfig } from './helpers.ts';

// made-up municipality and acts: no real data
const RSS = (items: Array<[string, string]>) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Albo online - Comune di Prova</title>
${items.map(([t, l]) => `<item><title><![CDATA[${t}]]></title><link>${l}</link><pubDate>Sat, 14 Nov 2026 09:00:00 +0100</pubDate></item>`).join('\n')}
</channel></rss>`;

const PAGE = `<html><head><meta charset="windows-1252"><title>Albo</title><script>var x = '<tr><a href="/x">Scavo finto nello script</a></tr>';</script></head><body>
<a href="/home">Home</a>
<table><thead><tr><th>N.</th><th>Oggetto</th><th></th></tr></thead><tbody>
<tr><td>101/2026</td><td>Autorizzazione all&#39;esecuzione di scavi in minitrincea per la posa di fibra ottica - Societ&agrave; Rete Prova S.r.l.</td><td><a href="javascript:void(0)">stampa</a> <a href="dettaglio.php?id=101">Visualizza</a></td></tr>
<tr><td>102/2026</td><td>Concessione loculi cimiteriali</td><td><a href="dettaglio.php?id=102">Visualizza</a></td></tr>
<tr><td>103/2026</td><td>Ordinanza timbratura cartellini</td><td><a href="dettaglio.php?id=103">Visualizza</a></td></tr>
</tbody></table></body></html>`;

describe('Albo e permessi: lettura degli elenchi', () => {
  it('keywords: whole words, without accents and case', () => {
    assert.deepEqual(matchKeywords('Posa di FIBRA ottica in via Roma', ['fibra', 'fibra ottica', 'scavo']), ['fibra', 'fibra ottica']);
    assert.deepEqual(matchKeywords('Ordinanza timbratura cartellini', ['tim']), [], '«tim» is not «timbratura»');
    assert.deepEqual(matchKeywords('Lavori TIM S.p.A. per la rete', ['tim']), ['tim']);
    assert.deepEqual(matchKeywords('Servizio di connettività Wi-Fi', DEFAULT_KEYWORDS.bandi), ['connettivita', 'wi fi']);
    assert.deepEqual(matchKeywords('Installazione stazione radio base 5G', DEFAULT_KEYWORDS.albo), ['stazione radio base', '5g']);
  });

  it('RSS and Atom feeds', () => {
    const rss = RSS([['Scavi per fibra ottica &amp; BUL', 'https://albo.example.it/atto/1']]);
    assert.ok(isFeed(rss));
    const items = parseFeed(rss, 'https://albo.example.it/rss');
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, 'Scavi per fibra ottica & BUL');
    assert.equal(items[0]!.url, 'https://albo.example.it/atto/1');
    assert.equal(items[0]!.publishedAt, '2026-11-14T08:00:00.000Z');
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Bando connettività scuole</title><link href="/bandi/7"/><updated>2026-11-10T10:00:00Z</updated><summary>Fornitura servizi di rete</summary></entry></feed>`;
    assert.ok(isFeed(atom));
    const a = parseFeed(atom, 'https://comune.example.it/feed');
    assert.equal(a[0]!.url, 'https://comune.example.it/bandi/7');
    assert.equal(a[0]!.title, 'Bando connettività scuole · Fornitura servizi di rete');
  });

  it('list page: one act per table row, its first real link; scripts ignored', () => {
    assert.ok(!isFeed(PAGE, 'text/html'));
    const items = parsePage(PAGE, 'https://albo.example.it/albo/elenco.php');
    assert.equal(items.length, 3);
    assert.equal(items[0]!.title, "101/2026 Autorizzazione all'esecuzione di scavi in minitrincea per la posa di fibra ottica - Società Rete Prova S.r.l.");
    assert.equal(items[0]!.url, 'https://albo.example.it/albo/dettaglio.php?id=101');
    assert.ok(!items.some((i) => /script/.test(i.title)));
    // without a table: the links with a long text
    const links = parsePage('<ul><li><a href="/a/1">Avviso di posa fibra ottica in via Verdi</a></li><li><a href="/">Home</a></li></ul>', 'https://x.example.it/');
    assert.deepEqual(links.map((l) => l.url), ['https://x.example.it/a/1']);
    assert.equal(charsetOf('text/html', PAGE), 'windows-1252');
    assert.equal(charsetOf('text/html; charset=ISO-8859-1', ''), 'iso-8859-1');
  });

  it('stable ids and public addresses only', () => {
    assert.equal(itemId('s1', { title: 'Scavi  FIBRA', url: 'u' }), itemId('s1', { title: 'scavi fibra', url: 'u' }));
    assert.notEqual(itemId('s1', { title: 'a', url: 'u' }), itemId('s2', { title: 'a', url: 'u' }));
    assert.equal(sourceUrlProblem('https://albo.example.it/elenco.php?tipo=1'), null);
    for (const bad of ['ftp://albo.example.it/', 'http://localhost/albo', 'http://192.168.1.1/albo', 'http://[::1]/', 'https://user:pw@albo.example.it/', 'http://intranet/albo', 'non un indirizzo'])
      assert.ok(sourceUrlProblem(bad), bad);
  });
});

describe('Albo e permessi: controllo, avvisi al NOC e accessi', () => {
  it('first reading without notifications, then only the new acts with the words', async () => {
    let feed: Array<[string, string]> = [
      ['Autorizzazione scavi per fibra ottica - via Roma', 'https://albo.example.it/atto/1'],
      ['Concessione loculi cimiteriali', 'https://albo.example.it/atto/2'],
    ];
    const fetches: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const u = String(input);
      fetches.push(u);
      if (u.startsWith('https://albo.example.it/')) return new Response(RSS(feed), { headers: { 'content-type': 'application/rss+xml' } });
      if (u.startsWith('https://bandi.example.it/')) return new Response(PAGE.replace('fibra ottica', 'servizi di connettività'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const { app, ctx } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, fetchImpl, telegramIntervalMs: 0 });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const A = { authorization: `Bearer ${tok}` };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => app.inject({ method, url, headers, payload });

    assert.equal((await call('GET', '/api/admin/albo')).statusCode, 404, 'module off by default');
    await call('PUT', '/api/admin/modules', { albo: true });

    const bad = await call('PUT', '/api/admin/albo/config', { sources: [{ comune: 'Prova', kind: 'albo', url: 'http://10.0.0.1/albo' }], keywords: DEFAULT_KEYWORDS });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'url_not_public');

    const saved = await call('PUT', '/api/admin/albo/config', {
      sources: [
        { comune: 'Prova', kind: 'albo', url: 'https://albo.example.it/rss' },
        { comune: 'Prova', kind: 'bandi', url: 'https://bandi.example.it/bandi' },
      ],
      keywords: DEFAULT_KEYWORDS,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().sources.length, 2);

    const pre = (await call('POST', '/api/admin/albo/preview', { url: 'https://albo.example.it/rss', kind: 'albo' })).json();
    assert.equal(pre.format, 'feed');
    assert.deepEqual(pre.items[0].keywords, ['fibra', 'fibra ottica', 'scavi']);

    // first check: the acts already there are kept silently
    const r1 = (await call('POST', '/api/admin/albo/check')).json();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.fresh, 0);
    let view = (await call('GET', '/api/admin/albo')).json();
    assert.deepEqual(view.items.map((i: { title: string }) => i.title).sort(), ['101/2026 Autorizzazione all\'esecuzione di scavi in minitrincea per la posa di servizi di connettività - Società Rete Prova S.r.l.', 'Autorizzazione scavi per fibra ottica - via Roma'].sort());
    const bandiState = Object.values(view.states as Record<string, { format: string; matched: number }>).find((s) => s.format === 'pagina')!;
    assert.equal(bandiState.matched, 1);
    const notices = () => (ctx.db.prepare("SELECT title, body FROM notifications WHERE kind = 'albo'").all() as Array<{ title: string; body: string }>);
    assert.equal(notices().length, 0);

    // a new act with the words and one without: only the first reaches the NOC
    feed = [['Nuova SRB per telefonia mobile - stazione radio base 5G', 'https://albo.example.it/atto/3'], ['Avviso pubblico mensa scolastica', 'https://albo.example.it/atto/4'], ...feed];
    const r2 = (await call('POST', '/api/admin/albo/check')).json();
    assert.equal(r2.fresh, 1);
    const n = notices();
    assert.equal(n.length, 1, 'one admin, one notification');
    assert.equal(n[0]!.title, '📜 Prova · Albo pretorio');
    const [title, link, words] = n[0]!.body.split('\n');
    assert.equal(title, 'Nuova SRB per telefonia mobile - stazione radio base 5G');
    assert.equal(link, 'https://albo.example.it/atto/3');
    assert.equal(words, 'Parole: telefonia mobile, stazione radio base, srb, 5g');
    // read again: nothing new
    assert.equal((await call('POST', '/api/admin/albo/check')).json().fresh, 0);
    view = (await call('GET', '/api/admin/albo?kind=albo')).json();
    assert.equal(view.items[0].url, 'https://albo.example.it/atto/3');
    assert.ok(view.items.every((i: { kind: string }) => i.kind === 'albo'));

    // a list that does not answer: the error stays on it, the others go on
    await call('PUT', '/api/admin/albo/config', { sources: [...saved.json().sources, { comune: 'Altro', kind: 'albo', url: 'https://giu.example.it/albo' }], keywords: DEFAULT_KEYWORDS });
    const r3 = (await call('POST', '/api/admin/albo/check')).json();
    assert.equal(r3.ok, false);
    assert.equal(r3.error, '1 elenchi non letti su 3');
    view = (await call('GET', '/api/admin/albo')).json();
    assert.equal(Object.values(view.states as Record<string, { ok: boolean; error?: string }>).filter((s) => !s.ok)[0]!.error, 'HTTP 404');

    // the lists are the admins': an installer gets nothing; a specialist without «visibilità piena» neither
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const tTok = (await call('POST', '/api/auth/login', { username: 'tecnico', password: 'Installer-Pass-123' }, {})).json().token;
    const T = { authorization: `Bearer ${tTok}` };
    assert.equal((await call('GET', '/api/admin/albo', undefined, T)).statusCode, 403);
    assert.equal((await call('POST', '/api/admin/albo/check', undefined, T)).statusCode, 403);
    await call('POST', '/api/admin/users', { username: 'esterno', password: 'Specialist-Pass-123', role: 'specialist' });
    const sTok = (await call('POST', '/api/auth/login', { username: 'esterno', password: 'Specialist-Pass-123' }, {})).json().token;
    assert.equal((await call('GET', '/api/admin/albo', undefined, { authorization: `Bearer ${sTok}` })).statusCode, 403);
    assert.ok(fetches.every((u) => /^https:\/\/(albo|bandi|giu)\.example\.it\//.test(u)), 'only the configured lists are read');
    await app.close();
  });
});
