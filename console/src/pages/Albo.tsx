import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Table } from '../ui';

/**
 * «Albo e permessi» (module albo, Carmelo 15/11/2026): the acts on networks (digs for fibre,
 * antennas, telecommunications) of the albo pretorio and the calls for tenders on connectivity of
 * the municipalities chosen by the admins. Who sees everything reads them; the admins choose the
 * lists and the words. New acts reach the NOC in Notifiche and on Telegram.
 */

type Kind = 'albo' | 'bandi';
const KIND_LABEL: Record<Kind, string> = { albo: 'Albo pretorio', bandi: 'Bandi e contratti' };
interface Source {
  id?: string;
  comune: string;
  kind: Kind;
  url: string;
  paused?: boolean;
}
interface SourceState {
  at: string;
  ok: boolean;
  error?: string;
  format?: 'feed' | 'pagina';
  items?: number;
  matched?: number;
}
interface Item {
  id: string;
  comune: string;
  kind: Kind;
  title: string;
  url: string;
  publishedAt: string | null;
  keywords: string[];
  firstSeen: string;
  notified: boolean;
}
interface View {
  config: { sources: Source[]; keywords: Record<Kind, string[]> };
  states: Record<string, SourceState>;
  status: { at: string; ok: boolean; error?: string; sources: number; fresh: number } | null;
  items: Item[];
}
interface Preview {
  format: 'feed' | 'pagina';
  total: number;
  items: Array<{ title: string; url: string; keywords: string[] }>;
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ERRORS: Record<string, string> = { url_invalid: 'indirizzo non valido (solo http o https)', url_not_public: 'indirizzo non pubblico', too_many_sources: 'troppi elenchi (al massimo 80)' };
const fail = (e: unknown) => toast(ERRORS[(e as Error).message] ?? (e as Error).message, 'bad');

export function Albo({ user }: PageContext) {
  const isAdmin = user.role === 'admin';
  const [kind, setKind] = useState<'all' | Kind>('all');
  const [comune, setComune] = useState('');
  const qs = new URLSearchParams({ ...(kind !== 'all' ? { kind } : {}), ...(comune ? { comune } : {}) }).toString();
  const q = useQuery({ queryKey: ['albo', qs], queryFn: () => api<View>(`/api/admin/albo${qs ? `?${qs}` : ''}`), refetchInterval: 60_000 });
  const comuni = [...new Set(q.data?.config.sources.map((s) => s.comune) ?? [])].sort();
  const check = async () => {
    const r = await api<{ fresh: number; ok: boolean; error?: string }>('/api/admin/albo/check', { method: 'POST' });
    toast(r.ok ? `Controllo fatto: ${r.fresh} atti nuovi` : `Controllo fatto con errori: ${r.error}`, r.ok ? 'good' : 'bad');
    await q.refetch();
  };
  return (
    <div className="ui-page">
      <PageHeader
        icon="cell_tower"
        title="Albo e permessi"
        subtitle="Atti dell’albo pretorio su scavi, fibra, antenne e telecomunicazioni e bandi su connettività e reti dei comuni scelti. Controllo ogni ora; i nuovi arrivano al NOC in Notifiche e su Telegram."
        actions={
          isAdmin ? (
            <AsyncButton icon="refresh" onClick={check} onError={fail}>
              Controlla ora
            </AsyncButton>
          ) : null
        }
      />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!q.data && !q.error && <Skeleton lines={4} />}
      {q.data && (
        <>
          {q.data.status && !q.data.status.ok && <Notice tone="warn" title="Ultimo controllo con errori">{`${date(q.data.status.at)}: ${q.data.status.error}. Il dettaglio è sotto, in Elenchi.`}</Notice>}
          <Card
            title="Atti trovati"
            actions={
              <Segmented
                label="Tipo"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: 'Tutti' },
                  { value: 'albo', label: 'Albo' },
                  { value: 'bandi', label: 'Bandi' },
                ]}
              />
            }
          >
            {comuni.length > 1 && (
              <div className="bn-filter">
                <select value={comune} onChange={(e) => setComune(e.target.value)} aria-label="Comune">
                  <option value="">Tutti i comuni</option>
                  {comuni.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
            {q.data.items.length ? (
              <Table
                rows={q.data.items}
                rowKey={(i) => i.id}
                columns={[
                  { label: 'Trovato', render: (i) => <span className="ui-small">{date(i.firstSeen)}</span> },
                  {
                    label: 'Comune',
                    render: (i) => (
                      <span>
                        {i.comune} <Badge tone={i.kind === 'albo' ? 'info' : 'brand'}>{i.kind === 'albo' ? 'albo' : 'bando'}</Badge>
                      </span>
                    ),
                  },
                  {
                    label: 'Atto',
                    render: (i) =>
                      i.url ? (
                        <a href={i.url} target="_blank" rel="noreferrer noopener">
                          {i.title}
                        </a>
                      ) : (
                        i.title
                      ),
                  },
                  { label: 'Parole', render: (i) => <span className="ui-small ui-muted">{i.keywords.join(', ')}</span> },
                  { label: '', render: (i) => (i.notified ? <Badge tone="good">avvisato</Badge> : <span className="ui-small ui-muted">già presente al primo controllo</span>) },
                ]}
              />
            ) : (
              <EmptyState title="Nessun atto con le parole scelte">
                {q.data.config.sources.length ? 'Gli atti che parlano di reti compaiono qui al primo controllo.' : 'Aggiungi i comuni e i loro elenchi qui sotto.'}
              </EmptyState>
            )}
          </Card>
          {isAdmin ? <Settings view={q.data} onSaved={() => void q.refetch()} /> : <SourcesList view={q.data} />}
        </>
      )}
    </div>
  );
}

const stateBadge = (s?: SourceState) =>
  !s ? <Badge tone="neutral">mai letto</Badge> : s.ok ? <Badge tone="good">{`${s.format === 'feed' ? 'feed' : 'pagina'} · ${s.items ?? 0} atti, ${s.matched ?? 0} con le parole`}</Badge> : <Badge tone="bad">{s.error ?? 'errore'}</Badge>;

/** Who sees everything but is not an admin: the lists, read only. */
function SourcesList({ view }: { view: View }) {
  return (
    <Card title="Elenchi controllati">
      <Table
        rows={view.config.sources}
        rowKey={(s) => s.id ?? s.url}
        empty="Nessun elenco."
        columns={[
          { label: 'Comune', render: (s) => s.comune },
          { label: 'Tipo', render: (s) => KIND_LABEL[s.kind] },
          { label: 'Stato', render: (s) => (s.paused ? <Badge tone="neutral">in pausa</Badge> : stateBadge(view.states[s.id ?? ''])) },
        ]}
      />
    </Card>
  );
}

/** Admins: the lists of each municipality, the words, a try of a list before saving. */
function Settings({ view, onSaved }: { view: View; onSaved: () => void }) {
  const [sources, setSources] = useState<Source[]>(view.config.sources);
  const [words, setWords] = useState<Record<Kind, string>>({ albo: view.config.keywords.albo.join('\n'), bandi: view.config.keywords.bandi.join('\n') });
  const [preview, setPreview] = useState<{ source: Source; data: Preview } | null>(null);
  useEffect(() => setSources(view.config.sources), [view.config.sources]);
  const set = (i: number, p: Partial<Source>) => setSources((list) => list.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const save = async () => {
    const body = {
      sources: sources.filter((s) => s.comune.trim() || s.url.trim()).map((s) => ({ ...(s.id ? { id: s.id } : {}), comune: s.comune, kind: s.kind, url: s.url, ...(s.paused ? { paused: true } : {}) })),
      keywords: { albo: words.albo.split('\n'), bandi: words.bandi.split('\n') },
    };
    await api('/api/admin/albo/config', { method: 'PUT', body });
    toast('Salvato: gli atti già presenti nei nuovi elenchi non mandano avvisi', 'good');
    onSaved();
  };
  const tryOne = async (s: Source) => setPreview({ source: s, data: await api<Preview>('/api/admin/albo/preview', { method: 'POST', body: { url: s.url, kind: s.kind } }) });
  return (
    <>
      <Card
        title="Elenchi dei comuni"
        actions={
          <Button icon="add_circle" onClick={() => setSources((l) => [...l, { comune: l.at(-1)?.comune ?? '', kind: 'albo', url: '' }])}>
            Aggiungi elenco
          </Button>
        }
      >
        <p className="ui-muted ui-small">
          Per ogni comune l’indirizzo della pagina dell’albo pretorio online e, se serve, quello di «Bandi di gara e contratti» in Amministrazione trasparente. Se la piattaforma del comune ha il feed RSS, usa quello: è più preciso. «Prova» mostra cosa si legge oggi.
        </p>
        {sources.length ? (
          <Table
            rows={sources.map((s, i) => ({ s, i }))}
            rowKey={({ s, i }) => s.id ?? `new-${i}`}
            columns={[
              { label: 'Comune', render: ({ s, i }) => <input value={s.comune} onChange={(e) => set(i, { comune: e.target.value })} placeholder="Comune" aria-label="Comune" /> },
              {
                label: 'Tipo',
                render: ({ s, i }) => (
                  <select value={s.kind} onChange={(e) => set(i, { kind: e.target.value as Kind })} aria-label="Tipo">
                    <option value="albo">Albo pretorio</option>
                    <option value="bandi">Bandi e contratti</option>
                  </select>
                ),
              },
              { label: 'Indirizzo', render: ({ s, i }) => <input className="ui-mono" value={s.url} onChange={(e) => set(i, { url: e.target.value })} placeholder="https://…" aria-label="Indirizzo" /> },
              {
                label: 'Stato',
                render: ({ s }) => (s.paused ? <Badge tone="neutral">in pausa</Badge> : s.id ? stateBadge(view.states[s.id]) : <Badge tone="neutral">da salvare</Badge>),
              },
              {
                label: '',
                render: ({ s, i }) => (
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'nowrap' }}>
                    <AsyncButton variant="ghost" disabled={!s.url} onClick={() => tryOne(s)} onError={fail}>
                      Prova
                    </AsyncButton>
                    <Button variant="ghost" onClick={() => set(i, { paused: !s.paused })}>
                      {s.paused ? 'Riprendi' : 'Pausa'}
                    </Button>
                    <Button variant="ghost" onClick={() => setSources((l) => l.filter((_, j) => j !== i))}>
                      Togli
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState title="Nessun comune">Aggiungi un elenco per ogni comune da seguire.</EmptyState>
        )}
        {preview && (
          <Notice tone="info" title={`Prova: ${preview.source.comune || preview.source.url}`}>
            {`Letto come ${preview.data.format === 'feed' ? 'feed RSS' : 'pagina'}: ${preview.data.total} atti, ${preview.data.items.filter((i) => i.keywords.length).length} con le parole.`}
            <ul className="bn-rules">
              {preview.data.items.slice(0, 15).map((i, k) => (
                <li key={k}>
                  {i.keywords.length ? <Badge tone="good">{i.keywords.join(', ')}</Badge> : null} {i.title}
                </li>
              ))}
            </ul>
          </Notice>
        )}
      </Card>
      <Card
        title="Parole che fanno scattare l’avviso"
        actions={
          <AsyncButton variant="primary" onClick={save} onError={fail}>
            Salva elenchi e parole
          </AsyncButton>
        }
      >
        <p className="ui-muted ui-small">Una per riga, parole intere senza badare a maiuscole e accenti («tim» non trova «timbro»). Più parole di fila valgono insieme.</p>
        <div className="ui-grid-2">
          <Field label="Albo pretorio">
            <textarea rows={10} value={words.albo} onChange={(e) => setWords({ ...words, albo: e.target.value })} />
          </Field>
          <Field label="Bandi e contratti">
            <textarea rows={10} value={words.bandi} onChange={(e) => setWords({ ...words, bandi: e.target.value })} />
          </Field>
        </div>
      </Card>
    </>
  );
}
