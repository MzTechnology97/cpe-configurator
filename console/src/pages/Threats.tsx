import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * «Minacce» (module threats, admins, Carmelo 15/11/2026, perimeter NIS2): the asset cards with their
 * domains, IPs and emails, checked once a day against ransomware.live (victims and indicators of
 * the ransomware groups), and the check of a password against the stolen lists, never stored.
 */

type Kind = 'sistema' | 'servizio' | 'dominio' | 'fornitore' | 'altro';
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'sistema', label: 'Sistema' },
  { value: 'servizio', label: 'Servizio' },
  { value: 'dominio', label: 'Dominio e posta' },
  { value: 'fornitore', label: 'Fornitore' },
  { value: 'altro', label: 'Altro' },
];
interface Asset {
  id: number;
  name: string;
  kind: Kind;
  searchName: boolean;
  domains: string[];
  ips: string[];
  emails: string[];
  notes: string;
  updatedAt: string;
}
interface Hit {
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
interface PasswordCheck {
  id: number;
  assetId: number;
  label: string;
  seen: number;
  checkedAt: string;
}
interface View {
  configured: boolean;
  status: { at: string; ok: boolean; error?: string; assets: number; calls: number; fresh: number } | null;
  assets: Asset[];
  hits: Hit[];
  passwordChecks: PasswordCheck[];
}
interface Draft {
  id?: number;
  name: string;
  kind: Kind;
  searchName: boolean;
  domains: string;
  ips: string;
  emails: string;
  notes: string;
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ERRORS: Record<string, string> = {
  invalid_indicators: 'alcuni domini, IP o email non sono validi',
  too_many_assets: 'troppe schede (al massimo 200)',
  ransomware_live_key_missing: 'manca la chiave di ransomware.live nel .env del server',
};
const fail = (e: unknown) => {
  const err = e as Error & { body?: { detail?: string[] } };
  const detail = err.body?.detail?.length ? `: ${err.body.detail.join(', ')}` : '';
  toast(`${ERRORS[err.message] ?? err.message}${detail}`, 'bad');
};
const lines = (s: string) => s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const empty: Draft = { name: '', kind: 'sistema', searchName: false, domains: '', ips: '', emails: '', notes: '' };

export function Threats() {
  const q = useQuery({ queryKey: ['threats'], queryFn: () => api<View>('/api/admin/threats'), refetchInterval: 60_000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pw, setPw] = useState<{ assetId: number; label: string; password: string } | null>(null);
  const d = q.data;

  const check = async () => {
    const r = await api<{ fresh: number; ok: boolean; error?: string }>('/api/admin/threats/check', { method: 'POST' });
    toast(r.ok ? `Controllo fatto: ${r.fresh} riscontri nuovi` : `Controllo fatto con errori: ${r.error}`, r.ok ? 'good' : 'bad');
    await q.refetch();
  };
  const save = async () => {
    if (!draft) return;
    const body = { name: draft.name.trim(), kind: draft.kind, searchName: draft.searchName, domains: lines(draft.domains), ips: lines(draft.ips), emails: lines(draft.emails), notes: draft.notes };
    await api(draft.id ? `/api/admin/threats/assets/${draft.id}` : '/api/admin/threats/assets', { method: draft.id ? 'PUT' : 'POST', body });
    toast('Scheda salvata', 'good');
    setDraft(null);
    await q.refetch();
  };
  const remove = async (a: Asset) => {
    if (!confirm(`Eliminare la scheda «${a.name}» con i suoi riscontri?`)) return;
    await api(`/api/admin/threats/assets/${a.id}`, { method: 'DELETE' });
    await q.refetch();
  };
  const checkPassword = async () => {
    if (!pw) return;
    const r = await api<PasswordCheck>(`/api/admin/threats/assets/${pw.assetId}/password`, { method: 'POST', body: { label: pw.label.trim(), password: pw.password } });
    setPw(null);
    toast(r.seen ? `«${r.label}»: trovata ${r.seen} volte nelle liste di password rubate. Cambiala.` : `«${r.label}»: non trovata nelle liste di password rubate.`, r.seen ? 'bad' : 'good');
    await q.refetch();
  };

  return (
    <div className="ui-page">
      <PageHeader
        icon="shield"
        title="Minacce"
        subtitle="Schede degli asset NIS2 (nostri e dei fornitori) con domini, IP ed email. Ogni giorno il server controlla su ransomware.live se compaiono tra le vittime o negli indicatori dei gruppi ransomware; i riscontri nuovi arrivano al NOC in Notifiche e su Telegram."
        actions={
          <AsyncButton icon="refresh" onClick={check} onError={fail} disabled={!d?.configured}>
            Controlla ora
          </AsyncButton>
        }
      />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={8} />}
      {d && (
        <>
          {!d.configured && (
            <Notice tone="warn" title="Manca la chiave di ransomware.live">
              Creala dal tuo profilo su ransomware.live e mettila nel .env del server come RANSOMWARE_LIVE_API_KEY, poi riavvia. Mai in chat o in un repository.
            </Notice>
          )}
          {d.status && (
            <p className="ui-muted ui-small">
              Ultimo controllo {date(d.status.at)}: {d.status.assets} schede, {d.status.calls} letture, {d.status.fresh} riscontri nuovi.
              {!d.status.ok && d.status.error ? ` Con errori: ${d.status.error}.` : ''}
            </p>
          )}

          <Card title="Riscontri">
            {d.hits.length ? (
              <Table
                rows={d.hits}
                rowKey={(h) => h.id}
                columns={[
                  { label: 'Trovato', render: (h) => <span className="ui-small">{date(h.firstSeen)}</span> },
                  { label: 'Asset', render: (h) => <strong>{h.assetName}</strong> },
                  { label: 'Cosa', render: (h) => (h.source === 'victim' ? <Badge tone="bad">tra le vittime</Badge> : <Badge tone="warn">negli indicatori</Badge>) },
                  { label: 'Indicatore', render: (h) => <span className="ui-mono ui-small">{h.indicator}</span> },
                  { label: 'Gruppo', render: (h) => h.group || '—' },
                  { label: 'Dettaglio', render: (h) => (h.url ? <a href={h.url} target="_blank" rel="noreferrer noopener">{h.title || 'apri'}</a> : <span className="ui-small">{h.title}</span>) },
                ]}
              />
            ) : (
              <EmptyState icon="verified_user" title="Nessun riscontro">
                Nessun dominio, nome, IP o email delle schede compare su ransomware.live.
              </EmptyState>
            )}
          </Card>

          <Card
            title={`Schede asset (${d.assets.length})`}
            actions={
              <Button icon="add" onClick={() => setDraft({ ...empty })}>
                Nuova scheda
              </Button>
            }
          >
            {draft && (
              <form onSubmit={(e) => e.preventDefault()}>
                <div className="ui-grid-2">
                  <Field label="Nome">
                    <input maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Es. Router di bordo, Posta aziendale, Fornitore di transito" />
                  </Field>
                  <Field label="Tipo">
                    <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}>
                      {KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <label className="ui-check ui-small">
                  <input type="checkbox" checked={draft.searchName} onChange={(e) => setDraft({ ...draft, searchName: e.target.checked })} /> Cerca anche il nome tra le vittime (aziende, fornitori: non per nomi generici)
                </label>
                <div className="ui-grid-2">
                  <Field label="Domini" hint="Uno per riga. Si cercano tra le vittime pubblicate e negli indicatori.">
                    <textarea rows={4} value={draft.domains} onChange={(e) => setDraft({ ...draft, domains: e.target.value })} />
                  </Field>
                  <Field label="IP" hint="Uno per riga. Restano sul server: si confrontano con gli indicatori scaricati.">
                    <textarea rows={4} value={draft.ips} onChange={(e) => setDraft({ ...draft, ips: e.target.value })} />
                  </Field>
                  <Field label="Email" hint="Una per riga. Restano sul server, come gli IP.">
                    <textarea rows={4} value={draft.emails} onChange={(e) => setDraft({ ...draft, emails: e.target.value })} />
                  </Field>
                  <Field label="Note">
                    <textarea rows={4} maxLength={1000} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  </Field>
                </div>
                <div className="ui-row">
                  <AsyncButton type="submit" variant="primary" onClick={save} onError={fail} disabled={draft.name.trim().length < 2}>
                    Salva scheda
                  </AsyncButton>
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    Annulla
                  </Button>
                </div>
              </form>
            )}
            {d.assets.length ? (
              <Table
                rows={d.assets}
                rowKey={(a) => a.id}
                columns={[
                  { label: 'Nome', render: (a) => <strong>{a.name}</strong> },
                  { label: 'Tipo', render: (a) => KINDS.find((k) => k.value === a.kind)?.label ?? a.kind },
                  { label: 'Domini', render: (a) => <span className="ui-small">{a.domains.join(', ') || '—'}</span> },
                  { label: 'IP', render: (a) => <span className="ui-small ui-mono">{a.ips.join(', ') || '—'}</span> },
                  { label: 'Email', render: (a) => <span className="ui-small">{a.emails.join(', ') || '—'}</span> },
                  {
                    label: 'Password controllate',
                    render: (a) => {
                      const c = d.passwordChecks.filter((p) => p.assetId === a.id);
                      return c.length ? (
                        <span className="ui-small">
                          {c.slice(0, 3).map((p) => (
                            <span key={p.id}>
                              {p.label} {p.seen ? <Badge tone="bad">rubata</Badge> : <Badge tone="good">ok</Badge>}{' '}
                            </span>
                          ))}
                        </span>
                      ) : (
                        '—'
                      );
                    },
                  },
                  {
                    label: '',
                    render: (a) => (
                      <div className="ui-row">
                        <Button onClick={() => setDraft({ id: a.id, name: a.name, kind: a.kind, searchName: a.searchName, domains: a.domains.join('\n'), ips: a.ips.join('\n'), emails: a.emails.join('\n'), notes: a.notes })}>Modifica</Button>
                        <Button onClick={() => setPw({ assetId: a.id, label: '', password: '' })}>Controlla password</Button>
                        <AsyncButton variant="danger" onClick={() => remove(a)} onError={fail}>
                          Elimina
                        </AsyncButton>
                      </div>
                    ),
                  },
                ]}
              />
            ) : (
              !draft && (
                <EmptyState icon="inventory_2" title="Nessuna scheda">
                  Aggiungi i sistemi, i servizi, i domini e i fornitori del perimetro NIS2.
                </EmptyState>
              )
            )}
          </Card>

          {pw && (
            <Card title={`Controlla una password · ${d.assets.find((a) => a.id === pw.assetId)?.name ?? ''}`}>
              <p className="ui-muted ui-small">
                La password non viene salvata né scritta nel registro. Al servizio Have I Been Pwned partono solo i primi 5 caratteri della sua impronta (SHA-1); il confronto si fa sul server. Resta solo il nome che scrivi e l’esito.
              </p>
              <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
                <Field label="Nome (es. admin router)">
                  <input maxLength={80} value={pw.label} onChange={(e) => setPw({ ...pw, label: e.target.value })} />
                </Field>
                <Field label="Password">
                  <input type="password" autoComplete="off" maxLength={256} value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
                </Field>
                <AsyncButton type="submit" variant="primary" onClick={checkPassword} onError={fail} disabled={!pw.label.trim() || !pw.password}>
                  Controlla
                </AsyncButton>
                <Button variant="ghost" onClick={() => setPw(null)}>
                  Annulla
                </Button>
              </form>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
