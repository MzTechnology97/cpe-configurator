import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Table } from '../ui';

/**
 * «Connettore MCP» (admins): the address of the MCP server of the platform, how to add it to an
 * MCP assistant (the desktop app with mcp-remote while the server has no public certificate, a
 * custom connector with a domain), what the assistant can read and change, and every
 * connection of the admins (read only, or read and write) with its use and the revoke. The consent
 * itself is given on the platform's own page (user, password and second step; changes only with a
 * second fresh code), never here.
 */

interface Mcp {
  url: string;
  /** write: a change (only for a connection given «lettura e scrittura»); network: on CPEs and UISP. */
  tools: Array<{ name: string; title: string; write?: boolean; network?: boolean }>;
  connections: Array<{ id: number; username: string; client: string; createdAt: string; lastUsedAt: string | null; calls: number; revokedAt: string | null; active: boolean; canWrite?: boolean }>;
}
type Conn = Mcp['connections'][number];
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copiato`);
  } catch {
    toast('Copia non riuscita: seleziona il testo e copialo a mano', 'bad');
  }
}

export function ConnettoreMcp() {
  const q = useQuery({ queryKey: ['admin', 'mcp'], queryFn: () => api<Mcp>('/api/admin/mcp') });
  const me = useQuery({ queryKey: ['auth', 'account'], queryFn: () => api<{ username: string; totpEnabled: boolean }>('/api/auth/account') });
  const [show, setShow] = useState<'active' | 'all'>('active');
  const [svcName, setSvcName] = useState('CRM interno');
  const [svcCode, setSvcCode] = useState('');
  const [svcToken, setSvcToken] = useState<{ token: string; name: string; expiresAt: string } | null>(null);
  const createService = async () => {
    const r = await api<{ token: string; name: string; expiresAt: string }>('/api/admin/mcp/service-tokens', { method: 'POST', body: { name: svcName.trim(), code: svcCode.trim() } });
    setSvcToken(r);
    setSvcCode('');
    await q.refetch();
  };
  const d = q.data;
  const revoke = async (c: Conn) => {
    if (!confirm(`Revocare la connessione di ${c.username} (${c.client})? L’assistente non potrà più leggere la piattaforma finché non si ricollega.`)) return;
    await api(`/api/admin/mcp/connections/${c.id}`, { method: 'DELETE' });
    toast('Connessione revocata');
    await q.refetch();
  };
  const rows = d ? d.connections.filter((c) => show === 'all' || c.active) : [];
  const desktop = d
    ? JSON.stringify({ mcpServers: { cdanet: { command: 'npx', args: ['-y', 'mcp-remote', d.url], env: { NODE_EXTRA_CA_CERTS: 'C:\\cdanet\\cdanet-ca.crt' } } } }, null, 2)
    : '';
  return (
    <div className="ui-page">
      <PageHeader icon="monitor_heart" title="Connettore MCP" subtitle="Un assistente compatibile MCP legge la piattaforma per il monitoraggio (stato rete, interruzioni, batterie dei POP, avvisi, interventi, magazzino, diagnosi) e, solo se lo consenti, fa anche modifiche." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={8} />}
      {me.data && !me.data.totpEnabled && (
        <Notice tone="bad">
          Per collegare un assistente serve la verifica in due passaggi sul tuo account: attivala in <a href="#/account">Il mio account</a>.
        </Notice>
      )}
      {d && (
        <>
          <Card title="Indirizzo del connettore">
            <div className="mcp-url">
              <code className="ui-mono">{d.url}</code>
              <Button onClick={() => void copy(d.url, 'Indirizzo')}>Copia</Button>
            </div>
            <p className="ui-muted ui-small cn-p">
              Al primo uso l’assistente apre la pagina di consenso della piattaforma: utente, password e codice di verifica, poi «Consenti». La pagina dice dove tornerai (il sito dell’assistente o questo computer): se non è il posto da cui sei partito, annulla. Senza la casella «Consenti anche le modifiche» la connessione resta in sola lettura; per le modifiche serve un secondo codice di verifica nuovo, e per passare da lettura a scrittura un nuovo consenso.
            </p>
          </Card>

          <Card title="Come collegarlo">
            <section className="cn-provider">
              <h3>App desktop sul PC (server senza dominio pubblico)</h3>
              <p className="ui-muted ui-small cn-p">
                Il PC deve raggiungere il server (ufficio o VPN) e avere Node.js. Salva il certificato della piattaforma (sul server: <code>sudo cdanet-cpe https-ca</code>) per esempio in <code>C:\cdanet\cdanet-ca.crt</code>, poi nella configurazione dei server MCP dell’app desktop aggiungi:
              </p>
              <pre className="mcp-pre">{desktop}</pre>
              <div className="ui-row">
                <Button onClick={() => void copy(desktop, 'Configurazione')}>Copia configurazione</Button>
              </div>
              <p className="ui-muted ui-small cn-p">Riavvia l’app. mcp-remote è un ponte open source di terze parti; funziona solo sul PC.</p>
            </section>
            <section className="cn-provider">
              <h3>Web, desktop e telefono con un dominio e un certificato valido</h3>
              <p className="ui-muted ui-small cn-p">Nelle impostazioni dell’assistente aggiungi un connettore personalizzato e incolla l’indirizzo qui sopra. Il connettore resta legato al tuo account, anche nell’app del telefono.</p>
            </section>
          </Card>

          <Card title="Cosa può fare">
            {[
              { title: 'Leggere', list: d.tools.filter((t) => !t.write), note: 'Con ogni connessione.' },
              { title: 'Modificare', list: d.tools.filter((t) => t.write && !t.network), note: 'Solo con «lettura e scrittura». Ogni modifica arriva come avviso al NOC.' },
              { title: 'Agire sulla rete', list: d.tools.filter((t) => t.network), note: 'Solo con «lettura e scrittura»: una CPE alla volta, al massimo 5 azioni all’ora per connessione, e l’assistente chiede conferma a ogni azione.' },
            ]
              .filter((g) => g.list.length)
              .map((g) => (
                <section key={g.title} className="mcp-group">
                  <h3>{g.title}</h3>
                  <p className="ui-muted ui-small cn-p">{g.note}</p>
                  <ul className="mcp-tools">
                    {g.list.map((t) => (
                      <li key={t.name}>{t.title}</li>
                    ))}
                  </ul>
                </section>
              ))}
            <p className="ui-muted ui-small cn-p">
              Mai password, chiavi, token o segreti; mai telefoni, email o codici fiscali dei clienti; elenchi fino a 200 elementi. Fuori dal connettore restano account e ruoli, connettori, impostazioni del server, informativa privacy, sblocco degli accessi e revoca delle connessioni, password PPPoE, chiavi Wi-Fi e nuovi subscriber. Ogni richiesta finisce nel Registro con il nome dello strumento. Quello che l’assistente legge passa dal suo fornitore: per i dati dei clienti serve l’accordo sul trattamento dei dati (DPA).
            </p>
          </Card>

          <Card title="Token di servizio (server interni)">
            <p className="ui-muted ui-small cn-p">
              Per un server nostro che legge gli stessi strumenti senza browser, per esempio il CRM interno: sempre in sola lettura, valido un anno, legato al tuo account (cade se cambi password o togli la verifica in due passaggi). Il server lo manda come <code>Authorization: Bearer …</code> a {d.url}. Si vede una volta sola: salvalo subito nel file di configurazione del server (.env), mai in chat o in un repository. Si revoca dalle Connessioni qui sotto.
            </p>
            {svcToken ? (
              <>
                <Notice tone="warn" title={`${svcToken.name} · scade il ${date(svcToken.expiresAt)}`}>
                  Copialo adesso: chiusa questa pagina non si potrà più vedere.
                </Notice>
                <pre className="mcp-pre">{svcToken.token}</pre>
                <div className="ui-row">
                  <Button onClick={() => void copy(svcToken.token, 'Token')}>Copia token</Button>
                  <Button variant="ghost" onClick={() => setSvcToken(null)}>
                    Fatto, nascondi
                  </Button>
                </div>
              </>
            ) : (
              <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
                <Field label="Nome del server">
                  <input maxLength={60} value={svcName} onChange={(e) => setSvcName(e.target.value)} />
                </Field>
                <Field label="Codice di verifica">
                  <input inputMode="numeric" autoComplete="one-time-code" maxLength={12} placeholder="123456" value={svcCode} onChange={(e) => setSvcCode(e.target.value)} />
                </Field>
                <AsyncButton type="submit" variant="primary" disabled={!me.data?.totpEnabled || svcName.trim().length < 2 || svcCode.trim().length < 6} onClick={createService} onError={fail}>
                  Crea token di servizio
                </AsyncButton>
              </form>
            )}
          </Card>

          <Card
            title="Connessioni"
            actions={
              <Segmented
                label="Mostra"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'active', label: `Attive (${d.connections.filter((c) => c.active).length})` },
                  { value: 'all', label: 'Tutte' },
                ]}
              />
            }
          >
            {rows.length ? (
              <Table
                rows={rows}
                rowKey={(c) => c.id}
                columns={[
                  { label: 'Admin', render: (c) => <strong>{c.username}</strong> },
                  { label: 'App', render: (c) => c.client },
                  { label: 'Permessi', render: (c) => (c.canWrite ? <Badge tone="warn">lettura e scrittura</Badge> : <Badge tone="neutral">sola lettura</Badge>) },
                  { label: 'Collegato', render: (c) => <span className="ui-small">{date(c.createdAt)}</span> },
                  { label: 'Ultimo uso', render: (c) => <span className="ui-small">{date(c.lastUsedAt)}</span> },
                  { label: 'Richieste', render: (c) => c.calls },
                  {
                    label: 'Stato',
                    render: (c) => (c.active ? <Badge tone="good">attiva</Badge> : c.revokedAt ? <Badge tone="neutral">{`revocata ${date(c.revokedAt)}`}</Badge> : <Badge tone="neutral">scaduta</Badge>),
                  },
                  {
                    label: '',
                    render: (c) =>
                      c.active ? (
                        <AsyncButton variant="danger" onClick={() => revoke(c)} onError={fail}>
                          Revoca
                        </AsyncButton>
                      ) : null,
                  },
                ]}
              />
            ) : (
              <EmptyState icon="link" title={show === 'active' ? 'Nessun assistente collegato' : 'Nessuna connessione'}>
                Le connessioni compaiono qui dopo il consenso. Una connessione cade da sola se l’admin viene disattivato, perde il ruolo, cambia password o toglie la verifica in due passaggi.
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
