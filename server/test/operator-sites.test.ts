import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { groupSites, parseBbox, parseCellLine, parseNets, siteOf } from '../src/services/operator-sites.ts';
import { ADMIN, testConfig } from './helpers.ts';

// made-up cells and coordinates: no real data
const BOX = parseBbox('36.5,12.0,38.4,15.8')!;
const NETS = parseNets('88:WindTre,99:WindTre');

describe('Antenne altri operatori: helpers', () => {
  it('reads box and networks, refuses the wrong ones', () => {
    assert.deepEqual(BOX, { south: 36.5, west: 12, north: 38.4, east: 15.8 });
    assert.equal(parseBbox('38,12,37,15'), null);
    assert.equal(parseBbox('a,b,c'), null);
    assert.deepEqual([...NETS], [[88, 'WindTre'], [99, 'WindTre']]);
    assert.equal(parseNets('x:Uno, 5:').size, 0);
  });

  it('keeps only the cells of our networks inside the box', () => {
    const ok = parseCellLine('LTE,222,88,1001,12345,0,14.30,37.40,1200,35,1,0,0,0', 222, NETS, BOX);
    assert.deepEqual(ok, { operator: 'WindTre', radio: 'LTE', lat: 37.4, lon: 14.3, range: 1200, samples: 35 });
    assert.equal(parseCellLine('LTE,222,1,1001,12345,0,14.30,37.40,1200,35,1,0,0,0', 222, NETS, BOX), null, 'another network');
    assert.equal(parseCellLine('LTE,222,88,1001,12345,0,9.10,45.40,1200,35,1,0,0,0', 222, NETS, BOX), null, 'outside the box');
    assert.equal(parseCellLine('radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal', 222, NETS, BOX), null, 'the header');
  });

  it('groups the cells within ~150 m in one site, position weighted by the samples', () => {
    const a = { operator: 'WindTre', radio: 'LTE', lat: 37.4, lon: 14.3, range: 800, samples: 30 };
    const b = { operator: 'WindTre', radio: 'NR', lat: 37.4003, lon: 14.3002, range: 1500, samples: 10 };
    const far = { operator: 'WindTre', radio: 'LTE', lat: 37.5, lon: 14.3, range: 500, samples: 1 };
    const sites = groupSites([a, b, far]).map(siteOf);
    assert.equal(sites.length, 2);
    const s = sites.find((x) => x.cells === 2)!;
    assert.deepEqual(s.radios, ['LTE', 'NR']);
    assert.equal(s.rangeM, 1500);
    assert.ok(Math.abs(s.lat - 37.400075) < 1e-6);
  });
});

describe('Antenne altri operatori: modulo', () => {
  it('import from the open data, sites by hand, staff only', async () => {
    const csv = [
      'radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal',
      'LTE,222,88,1001,1,0,14.30,37.40,800,30,1,0,0,0',
      'NR,222,99,1001,2,0,14.3002,37.4003,1500,10,1,0,0,0',
      'LTE,222,1,1001,3,0,14.30,37.40,800,30,1,0,0,0',
      'UMTS,222,88,1002,4,0,13.50,38.10,2000,5,1,0,0,0',
    ].join('\n');
    let answer: 'gz' | 'limit' = 'gz';
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      urls.push(String(input));
      return answer === 'gz' ? new Response(gzipSync(csv)) : new Response('RATE_LIMITED');
    }) as typeof fetch;
    const cfg = testConfig({ OPENCELLID_TOKEN: 'test-token-not-real', OPENCELLID_URL: 'https://ocid.example/ocid/downloads' });
    const { app, ctx } = await buildApp(cfg, 'test', { db: openDatabase(':memory:'), logger: false, fetchImpl, telegramIntervalMs: 0 });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const A = { authorization: `Bearer ${tok}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: A, payload });

    assert.equal((await call('GET', '/api/operator-sites')).statusCode, 404, 'module off by default');
    await call('PUT', '/api/admin/modules', { operator_sites: true });
    assert.equal((await app.inject({ method: 'GET', url: '/api/operator-sites' })).statusCode, 401);

    const run = await ctx.operatorSites.refresh();
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.deepEqual([run.cells, run.sites], [3, 2]);
    assert.match(urls[0]!, /^https:\/\/ocid\.example\/ocid\/downloads\?token=test-token-not-real&type=mcc&file=222\.csv\.gz$/);

    // a site by hand (Eolo doesn't publish its BTS)
    const bad = await call('POST', '/api/admin/operator-sites', { operator: 'Eolo', lat: 99, lon: 14, status: 'da confermare' });
    assert.equal(bad.statusCode, 400);
    const eolo = (await call('POST', '/api/admin/operator-sites', { operator: 'Eolo', lat: 37.45, lon: 14.25, status: 'da confermare', note: 'traliccio visto in zona' })).json();
    assert.equal(eolo.source, 'manuale');

    const all = (await call('GET', '/api/operator-sites?south=37&west=14&north=38&east=15')).json();
    assert.equal(all.sites.length, 2, 'the site outside the view is left out');
    assert.equal(all.sites[0].operator, 'Eolo', 'the sites by hand first');
    assert.deepEqual(all.sites[1].radios, ['LTE', 'NR']);
    assert.equal(all.configured, true);
    assert.equal(JSON.stringify(all).includes('test-token-not-real'), false, 'the token never goes to the page');
    assert.equal((await call('GET', '/api/operator-sites?operators=Eolo')).json().sites.length, 1);

    // a failed download keeps the old sites
    answer = 'limit';
    const again = await ctx.operatorSites.refresh();
    assert.deepEqual([again.ok, again.error], [false, 'opencellid_daily_limit']);
    assert.equal((await call('GET', '/api/operator-sites')).json().sites.length, 3);

    // edit and delete only the sites by hand
    const ed = await call('PUT', `/api/admin/operator-sites/${eolo.id}`, { operator: 'Eolo', lat: 37.45, lon: 14.25, status: 'confermata' });
    assert.equal(ed.json().status, 'confermata');
    const estimated = all.sites[1].id;
    assert.equal((await call('DELETE', `/api/admin/operator-sites/${estimated}`)).statusCode, 404);
    assert.equal((await call('DELETE', `/api/admin/operator-sites/${eolo.id}`)).statusCode, 200);
    await app.close();
  });
});
