import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * «Memorie di lavoro» (module ai_memory): the shared work memories of the AIs, read every hour from the
 * private repository with a read-only token. Shown as plain text (never rendered as HTML): they
 * are reviewed in Git, here they are only read. Admins can read them again now, and (v1.42.1) put
 * the read-only GitHub token here when the server has no SSH: with a fresh code, never shown again.
 */

interface State {
  commit: string | null;
  at: string | null;
  ok: boolean;
  error: string | null;
  skipped: Array<{ path: string; reason: string }>;
  count: number;
  configured: boolean;
  tokenSource: 'env' | 'console' | null;
  tokenSetAt: string | null;
  tokenSetBy: string | null;
  repo: string;
  ref: string;
}
interface FileRow {
  path: string;
  title: string;
  size: number;
  sha: string;
}
interface Memory {
  state: State;
  files: FileRow[];
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => {
  const detail = e instanceof ApiError && typeof e.body?.detail === 'string' ? e.body.detail : '';
  toast(detail ? `${(e as Error).message} (${detail})` : (e as Error).message, 'bad');
};
const folder = (p: string) => (p.includes('/playbook/') ? 'Playbook' : 'Memorie');

export function MemorieLavoro({ user }: PageContext) {
  const q = useQuery({ queryKey: ['ai-memory'], queryFn: () => api<Memory>('/api/admin/ai/memory') });
  const [open, setOpen] = useState<string | null>(null);
  const me = useQuery({ queryKey: ['auth', 'account'], queryFn: () => api<{ totpEnabled: boolean }>('/api/auth/account'), enabled: user.role === 'admin' });
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const saveToken = async () => {
    const r = await api<Memory>('/api/admin/ai/memory/token', { method: 'PUT', body: { token: token.trim(), code: code.trim() } });
    setToken('');
    setCode('');
    setEditing(false);
    toast(r.state.ok ? `Token salvato: letti ${r.state.count} file` : `Token salvato, ma la lettura non è riuscita: ${r.state.error ?? ''}`, r.state.ok ? undefined : 'bad');
    await q.refetch();
  };
  const removeToken = async () => {
    if (!window.confirm('Togliere il token? La copia già letta resta, ma non si aggiorna più.')) return;
    await api<Memory>('/api/admin/ai/memory/token', { method: 'DELETE' });
    toast('Token tolto');
    await q.refetch();
  };
  const file = useQuery({
    queryKey: ['ai-memory', 'file', open],
    queryFn: () => api<{ path: string; title: string; content: string }>(`/api/admin/ai/memory/file?path=${encodeURIComponent(open!)}`),
    enabled: !!open,
  });
  const refresh = async () => {
    const r = await api<Memory>('/api/admin/ai/memory/refresh', { method: 'POST', body: {} });
    toast(r.state.ok ? `Letti ${r.state.count} file` : `Lettura non riuscita: ${r.state.error ?? ''}`, r.state.ok ? undefined : 'bad');
    await q.refetch();
  };
  const s = q.data?.state;
  const isAdmin = user.role === 'admin';
  const tokenForm = (
    <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
      <Field label="Token GitHub (fine-grained, sola lettura)">
        <input type="password" autoComplete="off" spellCheck={false} maxLength={300} placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Field label="Codice di verifica">
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={12} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <AsyncButton type="submit" variant="primary" disabled={!me.data?.totpEnabled || !token.trim().startsWith('github_pat_') || code.trim().length < 6} onClick={saveToken} onError={fail}>
        Prova e salva
      </AsyncButton>
      {editing && (
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Annulla
        </Button>
      )}
    </form>
  );
  return (
    <div className="ui-page">
      <PageHeader icon="menu_book" title="Memorie di lavoro" subtitle="Le memorie di lavoro condivise dagli assistenti: profilo, decisioni, progetti e regole per dominio. Si scrivono e si rivedono in Git; qui si leggono. Gli assistenti collegati le ricevono con lo strumento memorie_cdanet." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!q.data && !q.error && <Skeleton lines={6} />}
      {s && (
        <Card
          title="Lettura dal repository"
          actions={
            user.role === 'admin' && s.configured ? (
              <AsyncButton onClick={refresh} onError={fail}>
                Leggi adesso
              </AsyncButton>
            ) : null
          }
        >
          {!s.configured ? (
            <>
              <Notice tone="warn" title="Token non configurato">
                Serve un token GitHub fine-grained in sola lettura (Contents: Read-only) sul solo repository {s.repo}. {isAdmin ? 'Incollalo qui sotto con un codice di verifica nuovo: GitHub lo prova subito, poi viene salvato cifrato e non si vede più.' : 'Lo inserisce un amministratore.'} Guida in docs/APPROVAZIONI-PC.md.
              </Notice>
              {isAdmin && me.data && !me.data.totpEnabled && <Notice tone="bad">Serve la verifica in due passaggi attiva sul tuo account (Account → Sicurezza).</Notice>}
              {isAdmin && tokenForm}
            </>
          ) : (
            <div className="ui-row">
              <Badge tone={s.ok ? 'good' : 'bad'}>{s.ok ? 'letto' : 'errore'}</Badge>
              <span className="ui-small">
                {s.repo} · {s.ref} · commit {s.commit ? s.commit.slice(0, 7) : '—'} · {date(s.at)} · {s.count} file
              </span>
            </div>
          )}
          {s.configured && (
            <div className="ui-row">
              <span className="ui-small">
                {s.tokenSource === 'env' ? 'Token dal file .env del server (si cambia lì).' : `Token inserito dalla console il ${date(s.tokenSetAt)} da ${s.tokenSetBy ?? '—'}.`}
              </span>
              {isAdmin && s.tokenSource === 'console' && !editing && (
                <>
                  <Button variant="ghost" onClick={() => setEditing(true)}>
                    Sostituisci
                  </Button>
                  <AsyncButton variant="ghost" onClick={removeToken} onError={fail}>
                    Togli
                  </AsyncButton>
                </>
              )}
            </div>
          )}
          {s.configured && editing && tokenForm}
          {s.error && <Notice tone={s.ok ? 'warn' : 'bad'}>{s.error}</Notice>}
          {s.skipped.length > 0 && (
            <Notice tone="warn" title={`${s.skipped.length} file scartati`}>
              Possibili segreti o dati personali: correggili nel repository (il contenuto non viene mai mostrato qui).
              <ul>
                {s.skipped.map((x) => (
                  <li key={x.path}>
                    <code className="ui-mono">{x.path}</code> · {x.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
        </Card>
      )}
      {q.data && (
        <Card title="File">
          {q.data.files.length ? (
            <Table
              rows={q.data.files}
              rowKey={(f) => f.path}
              columns={[
                { label: 'Cartella', render: (f) => <Badge tone="neutral">{folder(f.path)}</Badge> },
                {
                  label: 'Titolo',
                  render: (f) => (
                    <button type="button" className="ui-link" onClick={() => setOpen(f.path)}>
                      {f.title}
                    </button>
                  ),
                },
                { label: 'Percorso', render: (f) => <span className="ui-small ui-mono">{f.path}</span> },
                { label: 'Dimensione', render: (f) => <span className="ui-small">{Math.ceil(f.size / 1024)} KB</span> },
              ]}
            />
          ) : (
            <EmptyState icon="menu_book" title="Nessuna memoria">
              Dopo la prima lettura dal repository qui compaiono i file di memorie e playbook.
            </EmptyState>
          )}
        </Card>
      )}
      {open && (
        <Card title={file.data?.title ?? open}>
          {file.error && <Notice tone="bad">{(file.error as Error).message}</Notice>}
          {!file.data && !file.error && <Skeleton lines={8} />}
          {file.data && <pre className="mcp-pre ai-cmd">{file.data.content}</pre>}
        </Card>
      )}
    </div>
  );
}
