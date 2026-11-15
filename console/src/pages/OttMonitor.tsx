import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Table } from '../ui';

/**
 * «Servizi OTT e CDN» (Carmelo 15/11/2026): a free «Downdetector» of our own. The server opens each
 * service every minute from our network, as a customer would, and reads the official status
 * pages where they are public. Many services down together = a problem on our exit.
 */

type Category = 'streaming' | 'social' | 'cloud' | 'gaming' | 'cdn' | 'altro';
type State = 'ok' | 'lento' | 'irraggiungibile' | 'sconosciuto';
type Official = 'ok' | 'minor' | 'major' | 'manutenzione' | 'sconosciuto';
type StatusKind = 'none' | 'statuspage' | 'google';
interface Service {
  id: number;
  name: string;
  category: Category;
  probeUrl: string;
  statusKind: StatusKind;
  statusUrl: string;
  enabled: boolean;
  state: State;
  since: string | null;
  lastMs: number | null;
  baselineMs: number | null;
  official: Official;
  officialText: string;
  checkedAt: string | null;
  spark: Array<{ at: string; ms: number | null; fails: number }>;
}
interface Data {
  services: Service[];
  outage: { ours: boolean; down: number; total: number };
  lastAt: string | null;
}

const CATEGORIES: Array<{ value: Category | 'tutti'; label: string }> = [
  { value: 'tutti', label: 'Tutti' },
  { value: 'streaming', label: 'Streaming' },
  { value: 'social', label: 'Social' },
  { value: 'cloud', label: 'Cloud e lavoro' },
  { value: 'gaming', label: 'Giochi' },
  { value: 'cdn', label: 'CDN' },
  { value: 'altro', label: 'Altro' },
];
const STATE: Record<State, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; color: string }> = {
  ok: { label: 'regolare', tone: 'good', color: '#0f940f' },
  lento: { label: 'lento', tone: 'warn', color: '#d4a017' },
  irraggiungibile: { label: 'irraggiungibile', tone: 'bad', color: '#e4572e' },
  sconosciuto: { label: '—', tone: 'neutral', color: '#888' },
};
const OFFICIAL: Record<Official, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  ok: { label: 'nessun problema', tone: 'good' },
  minor: { label: 'problema minore', tone: 'warn' },
  major: { label: 'guasto grave', tone: 'bad' },
  manutenzione: { label: 'manutenzione', tone: 'warn' },
  sconosciuto: { label: '—', tone: 'neutral' },
};
const ERRORS: Record<string, string> = {
  url_invalid: 'Indirizzo non valido',
  url_protocol: 'Solo indirizzi https o http',
  url_credentials: 'Niente nome utente o password nell’indirizzo',
  url_not_public: 'Solo indirizzi pubblici su Internet',
  status_url_invalid: 'Indirizzo della pagina di stato non valido',
  status_url_not_public: 'La pagina di stato deve essere pubblica',
  too_many_services: 'Troppi servizi (al massimo 80)',
};
const fail = (e: unknown) => toast(ERRORS[(e as Error).message] ?? (e as Error).message, 'bad');
const time = (s: string | null) => (s ? new Date(s).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** The little graph of the last 24 hours: the time of the answer, red where probes failed. */
function Spark({ s }: { s: Service }) {
  const pts = s.spark;
  if (pts.length < 2) return <span className="ui-muted ui-small">—</span>;
  const W = 140;
  const H = 32;
  const max = Math.max(...pts.map((p) => p.ms ?? 0), (s.baselineMs ?? 0) * 2, 1);
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (ms: number) => H - 2 - (Math.min(ms, max) / max) * (H - 4);
  let d = '';
  pts.forEach((p, i) => {
    if (p.ms == null) return;
    d += `${d && pts[i - 1]?.ms != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.ms).toFixed(1)}`;
  });
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tempi di risposta di ${s.name} nelle ultime 24 ore`}>
      {pts.map((p, i) => (p.fails ? <rect key={i} x={x(i) - 1.5} y={0} width={3} height={H} fill="#e4572e" opacity={0.35} /> : null))}
      <path d={d} fill="none" stroke={STATE[s.state].color} strokeWidth={1.5} />
    </svg>
  );
}

type Draft = { id?: number; name: string; category: Category; probeUrl: string; statusKind: StatusKind; statusUrl: string; enabled: boolean };
const EMPTY: Draft = { name: '', category: 'streaming', probeUrl: 'https://', statusKind: 'none', statusUrl: '', enabled: true };

export function OttMonitor({ user }: PageContext) {
  const isAdmin = user.role === 'admin';
  const q = useQuery({ queryKey: ['ott'], queryFn: () => api<Data>('/api/ott'), refetchInterval: 60_000 });
  const [cat, setCat] = useState<Category | 'tutti'>('tutti');
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = q.data;
  const rank: Record<State, number> = { irraggiungibile: 0, lento: 1, ok: 2, sconosciuto: 3 };
  const items = (d?.services ?? [])
    .filter((s) => cat === 'tutti' || s.category === cat)
    .filter((s) => s.enabled || isAdmin)
    .sort((a, b) => rank[a.state] - rank[b.state] || (a.official === 'major' ? -1 : 0) - (b.official === 'major' ? -1 : 0) || a.name.localeCompare(b.name, 'it'));
  const down = (d?.services ?? []).filter((s) => s.enabled && s.state !== 'ok' && s.state !== 'sconosciuto');

  const check = async () => {
    await api('/api/admin/ott/check', { method: 'POST' });
    toast('Controllo fatto', 'good');
    await q.refetch();
  };
  const save = async () => {
    if (!draft) return;
    const body = { name: draft.name.trim(), category: draft.category, probeUrl: draft.probeUrl.trim(), statusKind: draft.statusKind, ...(draft.statusKind !== 'none' ? { statusUrl: draft.statusUrl.trim() } : {}), enabled: draft.enabled };
    await api(draft.id ? `/api/admin/ott/${draft.id}` : '/api/admin/ott', { method: draft.id ? 'PUT' : 'POST', body });
    toast('Servizio salvato', 'good');
    setDraft(null);
    await q.refetch();
  };
  const remove = async (s: Service) => {
    if (!window.confirm(`Togliere ${s.name} dal controllo?`)) return;
    await api(`/api/admin/ott/${s.id}`, { method: 'DELETE' });
    await q.refetch();
  };

  return (
    <>
      <PageHeader
        icon="live_tv"
        title="Servizi OTT e CDN"
        subtitle="Streaming, social, cloud e CDN visti dalla nostra rete ogni minuto, con le pagine di stato ufficiali"
        actions={isAdmin ? <AsyncButton icon="refresh" onClick={check} onError={fail}>Controlla ora</AsyncButton> : null}
      />
      {d?.outage.ours && (
        <Notice tone="bad" title={`${d.outage.down} servizi su ${d.outage.total} irraggiungibili insieme`}>
          Quando tanti servizi cadono insieme il problema è quasi sempre nostro: transito, DNS o router di bordo. Controllare prima la nostra uscita.
        </Notice>
      )}
      {d && !d.outage.ours && down.length > 0 && (
        <Notice tone="warn" title={`${down.length} ${down.length === 1 ? 'servizio con problemi' : 'servizi con problemi'}`}>
          {down.map((s) => `${s.name} (${STATE[s.state].label})`).join(', ')}. Se i clienti segnalano problemi solo su questi, il guasto è probabilmente loro.
        </Notice>
      )}
      <Card
        title="Stato dei servizi"
        actions={<Segmented label="Categoria" value={cat} options={CATEGORIES} onChange={setCat} />}
      >
        {!d ? (
          <Skeleton lines={8} />
        ) : !items.length ? (
          <EmptyState icon="live_tv" title="Nessun servizio in questa categoria" />
        ) : (
          <Table
            rows={items}
            rowKey={(s) => s.id}
            columns={[
              {
                label: 'Servizio',
                render: (s) => (
                  <span>
                    <span style={{ color: STATE[s.state].color, fontSize: 18, verticalAlign: 'middle' }}>●</span> <strong>{s.name}</strong>
                    {!s.enabled && <span className="ui-muted ui-small"> (spento)</span>}
                  </span>
                ),
              },
              { label: 'Dalla nostra rete', render: (s) => <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge> },
              { label: 'Ultime 24 ore', render: (s) => <Spark s={s} /> },
              { label: 'Risposta', render: (s) => <span className="ui-small">{s.lastMs != null ? `${s.lastMs} ms` : '—'}{s.baselineMs != null ? ` (di solito ${s.baselineMs})` : ''}</span> },
              {
                label: 'Pagina ufficiale',
                render: (s) =>
                  s.statusKind === 'none' ? (
                    <span className="ui-muted ui-small">non pubblica</span>
                  ) : (
                    <span title={s.officialText}>
                      <Badge tone={OFFICIAL[s.official].tone}>{OFFICIAL[s.official].label}</Badge>
                      {s.officialText && s.official !== 'ok' ? <span className="ui-small"> {s.officialText}</span> : null}
                    </span>
                  ),
              },
              ...(isAdmin
                ? [
                    {
                      label: '',
                      render: (s: Service) => (
                        <>
                          <Button variant="ghost" icon="edit" onClick={() => setDraft({ id: s.id, name: s.name, category: s.category, probeUrl: s.probeUrl, statusKind: s.statusKind, statusUrl: s.statusUrl, enabled: s.enabled })}>Modifica</Button>
                          <AsyncButton variant="ghost" icon="delete" onClick={() => remove(s)} onError={fail}>Togli</AsyncButton>
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        <p className="ui-muted ui-small">
          Ultimo controllo {time(d?.lastAt ?? null)}. «Irraggiungibile» dopo 3 prove fallite di fila; «lento» quando risponde più di 3 volte più piano del solito. Le pagine ufficiali si leggono ogni 5 minuti dove il servizio ne pubblica una in formato aperto. Downdetector non ha un servizio gratuito: questo è il nostro, dalla nostra rete.
        </p>
      </Card>

      {isAdmin && (
        <Card title="Servizi controllati" actions={!draft && <Button icon="add" onClick={() => setDraft({ ...EMPTY })}>Aggiungi servizio</Button>}>
          {draft ? (
            <form onSubmit={(e) => e.preventDefault()}>
              <div className="ui-grid-2">
                <Field label="Nome">
                  <input maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Es. NOW, Paramount+, Vimeo" />
                </Field>
                <Field label="Categoria">
                  <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}>
                    {CATEGORIES.filter((c) => c.value !== 'tutti').map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Indirizzo da provare" hint="La pagina che apre un cliente, per esempio https://www.servizio.it/">
                  <input maxLength={300} value={draft.probeUrl} onChange={(e) => setDraft({ ...draft, probeUrl: e.target.value })} />
                </Field>
                <Field label="Pagina di stato ufficiale">
                  <select value={draft.statusKind} onChange={(e) => setDraft({ ...draft, statusKind: e.target.value as StatusKind })}>
                    <option value="none">Nessuna o non in formato aperto</option>
                    <option value="statuspage">Statuspage (…/api/v2/summary.json)</option>
                    <option value="google">Google (incidents.json)</option>
                  </select>
                </Field>
                {draft.statusKind !== 'none' && (
                  <Field label="Indirizzo della pagina di stato" hint={draft.statusKind === 'statuspage' ? 'Solo l’indirizzo base, per esempio https://www.githubstatus.com' : 'L’indirizzo completo del file incidents.json'}>
                    <input maxLength={300} value={draft.statusUrl} onChange={(e) => setDraft({ ...draft, statusUrl: e.target.value })} />
                  </Field>
                )}
                <Field label="Controllo">
                  <label>
                    <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Acceso
                  </label>
                </Field>
              </div>
              <p>
                <AsyncButton variant="primary" icon="save" onClick={save} onError={fail}>Salva</AsyncButton> <Button variant="ghost" onClick={() => setDraft(null)}>Annulla</Button>
              </p>
            </form>
          ) : (
            <p className="ui-small ui-muted">Si aggiungono i servizi che usano i nostri clienti. Il server apre solo l’indirizzo indicato, come farebbe un cliente, e non invia nessun dato.</p>
          )}
        </Card>
      )}
    </>
  );
}
