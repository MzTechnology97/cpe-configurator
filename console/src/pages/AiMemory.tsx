import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Card, EmptyState, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * «Conoscenza AI» (module ai_memory): the shared work memories of the AIs, read every hour from the
 * private repository with a read-only token. Shown as plain text (never rendered as HTML): they
 * are reviewed in Git, here they are only read. Admins can read them again now.
 */

interface State {
  commit: string | null;
  at: string | null;
  ok: boolean;
  error: string | null;
  skipped: Array<{ path: string; reason: string }>;
  count: number;
  configured: boolean;
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
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const folder = (p: string) => (p.includes('/playbook/') ? 'Playbook' : 'Memorie');

export function AiMemory({ user }: PageContext) {
  const q = useQuery({ queryKey: ['ai-memory'], queryFn: () => api<Memory>('/api/admin/ai/memory') });
  const [open, setOpen] = useState<string | null>(null);
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
  return (
    <div className="ui-page">
      <PageHeader icon="menu_book" title="Conoscenza AI" subtitle="Le memorie di lavoro condivise dalle AI: profilo, decisioni, progetti e regole per dominio. Si scrivono e si rivedono in Git; qui si leggono. Claude le riceve con lo strumento memorie_cdanet." />
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
            <Notice tone="warn" title="Token non configurato">
              Serve un token GitHub fine-grained in sola lettura (Contents: Read-only) sul solo repository {s.repo}, nel file .env del server come AI_HUB_TOKEN. Guida in docs/ASSISTENTE-AI.md.
            </Notice>
          ) : (
            <div className="ui-row">
              <Badge tone={s.ok ? 'good' : 'bad'}>{s.ok ? 'letto' : 'errore'}</Badge>
              <span className="ui-small">
                {s.repo} · {s.ref} · commit {s.commit ? s.commit.slice(0, 7) : '—'} · {date(s.at)} · {s.count} file
              </span>
            </div>
          )}
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
