import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Table } from '../ui';

/**
 * «Assistente AI» (module ai_assistant, admins): the AIs working on the PCs with Continuity ask for
 * permission; the admin who owns the agent denies with a tap or allows with a fresh code. The text
 * of a request is written by an AI: shown as plain monospaced text, never as markup. Requests the
 * PC keeps for itself (git push, credentials, network devices) can only be denied from here.
 */

interface Session {
  ref: string;
  goal: string;
  ai: string;
  state: string;
  project: string;
}
interface Agent {
  id: number;
  name: string;
  owner: string;
  ownerId: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  version: string;
  pending: number;
  active: boolean;
  sessions: Session[];
}
interface Request {
  id: number;
  agent: string;
  owner: string;
  ownerId: number;
  ai: string;
  tool: string;
  detail: string;
  localOnly: boolean;
  state: 'pending' | 'allowed' | 'denied' | 'expired';
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const STATE: Record<Request['state'], { label: string; tone: 'good' | 'bad' | 'warn' | 'neutral' }> = {
  pending: { label: 'in attesa', tone: 'warn' },
  allowed: { label: 'consentita', tone: 'good' },
  denied: { label: 'negata', tone: 'bad' },
  expired: { label: 'scaduta (negata)', tone: 'neutral' },
};
/** Seen in the last 2 minutes: the agent is connected. */
const online = (a: Agent) => !!a.lastSeenAt && Date.now() - Date.parse(a.lastSeenAt) < 120_000;

export function AiAssistant() {
  const agents = useQuery({ queryKey: [...keys.ai, 'agents'], queryFn: () => api<{ agents: Agent[]; maxDays: number }>('/api/admin/ai/agents'), refetchInterval: 30_000 });
  const pending = useQuery({ queryKey: [...keys.ai, 'pending'], queryFn: () => api<{ requests: Request[] }>('/api/admin/ai/requests?state=pending'), refetchInterval: 15_000 });
  const history = useQuery({ queryKey: [...keys.ai, 'history'], queryFn: () => api<{ requests: Request[] }>('/api/admin/ai/requests') });
  const me = useQuery({ queryKey: ['auth', 'account'], queryFn: () => api<{ id?: number; username: string; totpEnabled: boolean }>('/api/auth/account') });
  const [codes, setCodes] = useState<Record<number, string>>({});
  const [name, setName] = useState('PC ufficio');
  const [code, setCode] = useState('');
  const [made, setMade] = useState<{ token: string; name: string; expiresAt: string } | null>(null);
  const [show, setShow] = useState<'active' | 'all'>('active');

  const refresh = async () => {
    await Promise.all([agents.refetch(), pending.refetch(), history.refetch()]);
  };
  const decide = async (r: Request, allow: boolean) => {
    await api(`/api/admin/ai/requests/${r.id}/decision`, { method: 'POST', body: allow ? { allow, code: (codes[r.id] ?? '').trim() } : { allow } });
    setCodes((c) => ({ ...c, [r.id]: '' }));
    toast(allow ? 'Comando consentito' : 'Comando negato');
    await refresh();
  };
  const create = async () => {
    const r = await api<{ token: string; name: string; expiresAt: string }>('/api/admin/ai/agents', { method: 'POST', body: { name: name.trim(), code: code.trim() } });
    setMade(r);
    setCode('');
    await refresh();
  };
  const revoke = async (a: Agent) => {
    if (!confirm(`Revocare l’agente «${a.name}»? Le sue richieste in attesa diventano negate e il PC non potrà più collegarsi.`)) return;
    await api(`/api/admin/ai/agents/${a.id}`, { method: 'DELETE' });
    toast('Agente revocato');
    await refresh();
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Token copiato');
    } catch {
      toast('Copia non riuscita: seleziona il testo e copialo a mano', 'bad');
    }
  };

  const list = agents.data?.agents.filter((a) => show === 'all' || a.active) ?? [];
  const mine = (r: Request) => me.data?.username === r.owner;
  return (
    <div className="ui-page">
      <PageHeader icon="memory" title="Assistente AI" subtitle="Le AI che lavorano sui PC con Continuity chiedono il permesso per i comandi: nega con un tocco, consenti con un codice di verifica nuovo." />
      {me.data && !me.data.totpEnabled && (
        <Notice tone="bad">
          Serve la verifica in due passaggi sul tuo account: attivala in <a href="#/account">Il mio account</a>.
        </Notice>
      )}

      <Card title={`Richieste in attesa${pending.data ? ` (${pending.data.requests.length})` : ''}`}>
        {pending.error && <Notice tone="bad">{(pending.error as Error).message}</Notice>}
        {!pending.data && !pending.error && <Skeleton lines={3} />}
        {pending.data && !pending.data.requests.length && (
          <EmptyState icon="check_circle" title="Nessuna richiesta">
            Quando un’AI chiede il permesso per un comando ricevi una notifica (app, Notifiche e Telegram personale, senza il comando). Senza risposta entro 10 minuti la richiesta vale «negata».
          </EmptyState>
        )}
        {pending.data?.requests.map((r) => (
          <section key={r.id} className="cn-provider">
            <div className="ui-row">
              <strong>{r.agent}</strong>
              <span className="ui-muted ui-small">
                {r.ai || 'AI'} · {r.tool} · {date(r.createdAt)} · scade {date(r.expiresAt)}
              </span>
              {r.localOnly && <Badge tone="warn">solo dal PC</Badge>}
            </div>
            <p className="ui-muted ui-small">Testo generato dall’AI, ripulito dei segreti: leggilo prima di decidere.</p>
            <pre className="mcp-pre ai-cmd">{r.detail || (mine(r) ? '(nessun dettaglio)' : `Il testo del comando lo vede solo ${r.owner}.`)}</pre>
            {!mine(r) ? (
              <p className="ui-muted ui-small">Decide l’amministratore che possiede l’agente ({r.owner}).</p>
            ) : (
              <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
                <AsyncButton variant="danger" onClick={() => decide(r, false)} onError={fail}>
                  Nega
                </AsyncButton>
                {r.localOnly ? (
                  <span className="ui-muted ui-small">Comando sensibile: si consente solo sul PC, davanti allo schermo.</span>
                ) : (
                  <>
                    <Field label="Codice di verifica">
                      <input
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={12}
                        placeholder="123456"
                        value={codes[r.id] ?? ''}
                        onChange={(e) => setCodes((c) => ({ ...c, [r.id]: e.target.value }))}
                      />
                    </Field>
                    <AsyncButton variant="primary" disabled={(codes[r.id] ?? '').trim().length < 6} onClick={() => decide(r, true)} onError={fail}>
                      Consenti
                    </AsyncButton>
                  </>
                )}
              </form>
            )}
          </section>
        ))}
      </Card>

      <Card
        title="PC collegati (agenti)"
        actions={
          <Segmented
            label="Mostra"
            value={show}
            onChange={setShow}
            options={[
              { value: 'active', label: `Attivi (${agents.data?.agents.filter((a) => a.active).length ?? 0})` },
              { value: 'all', label: 'Tutti' },
            ]}
          />
        }
      >
        {agents.error && <Notice tone="bad">{(agents.error as Error).message}</Notice>}
        {list.length ? (
          <Table
            rows={list}
            rowKey={(a) => a.id}
            columns={[
              { label: 'PC', render: (a) => <strong>{a.name}</strong> },
              { label: 'Admin', render: (a) => a.owner },
              { label: 'Stato', render: (a) => (!a.active ? <Badge tone="neutral">{a.revokedAt ? 'revocato' : 'scaduto'}</Badge> : online(a) ? <Badge tone="good">collegato</Badge> : <Badge tone="neutral">non collegato</Badge>) },
              { label: 'Sessioni AI', render: (a) => (a.sessions.length ? a.sessions.map((s) => <div key={s.ref} className="ui-small">{`${s.project || '—'} · ${s.ai} · ${s.state}${s.goal ? ` · ${s.goal}` : ''}`}</div>) : <span className="ui-muted ui-small">nessuna</span>) },
              { label: 'In attesa', render: (a) => a.pending },
              { label: 'Ultimo contatto', render: (a) => <span className="ui-small">{date(a.lastSeenAt)}</span> },
              { label: 'Scade', render: (a) => <span className="ui-small">{date(a.expiresAt)}</span> },
              {
                label: '',
                render: (a) =>
                  a.active ? (
                    <AsyncButton variant="danger" onClick={() => revoke(a)} onError={fail}>
                      Revoca
                    </AsyncButton>
                  ) : null,
              },
            ]}
          />
        ) : (
          <EmptyState icon="link" title="Nessun PC collegato">
            Crea un agente qui sotto e avvia sul PC (utente Windows dedicato alle AI) l’agente della piattaforma con il token.
          </EmptyState>
        )}
      </Card>

      <Card title="Collega un PC">
        <p className="ui-muted ui-small cn-p">
          Il token vale al massimo {agents.data?.maxDays ?? 90} giorni ed è legato al tuo account: cade se cambi password, perdi il ruolo o togli la verifica in due passaggi. Si vede una volta sola: salvalo sul PC nell’Archivio credenziali di Windows, mai in chat, in un file o in un repository. Il PC si collega lui alla piattaforma: non serve aprire porte.
        </p>
        {made ? (
          <>
            <Notice tone="warn" title={`${made.name} · scade il ${date(made.expiresAt)}`}>
              Copialo adesso: chiusa questa pagina non si potrà più vedere.
            </Notice>
            <pre className="mcp-pre">{made.token}</pre>
            <div className="ui-row">
              <Button onClick={() => void copy(made.token)}>Copia token</Button>
              <Button variant="ghost" onClick={() => setMade(null)}>
                Fatto, nascondi
              </Button>
            </div>
          </>
        ) : (
          <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
            <Field label="Nome del PC">
              <input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Codice di verifica">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={12} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <AsyncButton type="submit" variant="primary" disabled={!me.data?.totpEnabled || name.trim().length < 2 || code.trim().length < 6} onClick={create} onError={fail}>
              Crea agente
            </AsyncButton>
          </form>
        )}
      </Card>

      <Card title="Ultime decisioni">
        {history.data?.requests.filter((r) => r.state !== 'pending').length ? (
          <Table
            rows={history.data.requests.filter((r) => r.state !== 'pending').slice(0, 50)}
            rowKey={(r) => r.id}
            columns={[
              { label: 'Quando', render: (r) => <span className="ui-small">{date(r.createdAt)}</span> },
              { label: 'PC', render: (r) => r.agent },
              { label: 'Strumento', render: (r) => r.tool },
              { label: 'Esito', render: (r) => <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge> },
              { label: 'Da', render: (r) => r.decidedBy ?? '—' },
            ]}
          />
        ) : (
          <EmptyState icon="history" title="Nessuna decisione">
            Le richieste restano 30 giorni; nel Registro attività resta lo strumento, mai il comando.
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
