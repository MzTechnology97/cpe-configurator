import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, download } from '../lib/api';
import { toast } from '../lib/toast';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * «Manuali e documentazione» (Carmelo 15/11/2026): manuals, datasheets and suppliers' FAQ as PDFs,
 * for the staff after login. The admins upload them; the files stay on the server, never in the
 * repository and never on a public address.
 */

interface Doc {
  id: number;
  title: string;
  category: string;
  summary: string;
  filename: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const ERRORS: Record<string, string> = {
  document_not_pdf: 'Il file non è un PDF',
  document_exists: 'Questo PDF è già stato caricato',
  document_content_type: 'Caricamento non valido: scegli un file PDF',
  too_many_documents: 'Troppi documenti (al massimo 500)',
};
const fail = (e: unknown) => toast(ERRORS[(e as Error).message] ?? (e as Error).message, 'bad');

async function openPdf(d: Doc) {
  const r = await api<Response>(`/api/docs/${d.id}/file`, { raw: true });
  if (!r.ok) throw new Error(`Apertura non riuscita (HTTP ${r.status})`);
  const url = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: 'application/pdf' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Docs({ user }: PageContext) {
  const isAdmin = user.role === 'admin';
  const q = useQuery({ queryKey: ['docs'], queryFn: () => api<{ items: Doc[] }>('/api/docs') });
  const file = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ title: '', category: '', summary: '' });
  const [edit, setEdit] = useState<Doc | null>(null);
  const [filter, setFilter] = useState('');
  const items = (q.data?.items ?? []).filter((d) => !filter || `${d.title} ${d.category} ${d.summary}`.toLowerCase().includes(filter.toLowerCase()));

  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) throw new Error('Scegli il file PDF');
    if (f.size > 30 * 1024 * 1024) throw new Error('Il PDF supera 30 MB');
    const qs = new URLSearchParams({ title: form.title.trim() || f.name.replace(/\.pdf$/i, ''), category: form.category.trim(), summary: form.summary.trim(), name: f.name }).toString();
    await api(`/api/admin/docs?${qs}`, { method: 'POST', body: new Uint8Array(await f.arrayBuffer()), headers: { 'Content-Type': 'application/pdf' } });
    toast('Documento caricato', 'good');
    if (file.current) file.current.value = '';
    setForm({ title: '', category: form.category, summary: '' });
    await q.refetch();
  };
  const save = async () => {
    if (!edit) return;
    await api(`/api/admin/docs/${edit.id}`, { method: 'PUT', body: { title: edit.title.trim(), category: edit.category.trim(), summary: edit.summary.trim() } });
    setEdit(null);
    await q.refetch();
  };
  const remove = async (d: Doc) => {
    if (!confirm(`Eliminare «${d.title}»?`)) return;
    await api(`/api/admin/docs/${d.id}`, { method: 'DELETE' });
    await q.refetch();
  };

  return (
    <div className="ui-page">
      <PageHeader icon="library_books" title="Manuali e documentazione" subtitle="Manuali, schede tecniche e FAQ dei fornitori in PDF, riservati allo staff. I file restano sul server della piattaforma." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {isAdmin && (
        <Card title="Carica un PDF">
          <form className="ui-grid-form" onSubmit={(e) => e.preventDefault()}>
            <Field label="File (PDF, fino a 30 MB)">
              <input ref={file} type="file" accept="application/pdf,.pdf" />
            </Field>
            <Field label="Titolo">
              <input maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Se vuoto: il nome del file" />
            </Field>
            <Field label="Sezione">
              <input maxLength={80} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Es. FWA 4G/5G, CPE, Procedure" />
            </Field>
            <Field label="Riassunto breve">
              <input maxLength={2000} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
            </Field>
            <AsyncButton type="submit" variant="primary" icon="upload" onClick={upload} onError={fail}>
              Carica
            </AsyncButton>
          </form>
        </Card>
      )}
      <Card
        title="Documenti"
        actions={<input type="search" placeholder="Cerca" aria-label="Cerca" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      >
        {!q.data && !q.error && <Skeleton lines={4} />}
        {edit && (
          <form className="ui-grid-form" onSubmit={(e) => e.preventDefault()}>
            <Field label="Titolo">
              <input maxLength={160} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </Field>
            <Field label="Sezione">
              <input maxLength={80} value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
            </Field>
            <Field label="Riassunto breve">
              <input maxLength={2000} value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} />
            </Field>
            <div className="ui-row">
              <AsyncButton type="submit" variant="primary" onClick={save} onError={fail} disabled={edit.title.trim().length < 2}>
                Salva
              </AsyncButton>
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Annulla
              </Button>
            </div>
          </form>
        )}
        {q.data &&
          (items.length ? (
            <Table
              rows={items}
              rowKey={(d) => d.id}
              columns={[
                { label: 'Sezione', render: (d) => d.category || '—' },
                {
                  label: 'Documento',
                  render: (d) => (
                    <div>
                      <strong>{d.title}</strong>
                      {d.summary && <div className="ui-small ui-muted">{d.summary}</div>}
                    </div>
                  ),
                },
                { label: 'Dimensione', render: (d) => <span className="ui-small">{MB(d.size)}</span> },
                {
                  label: '',
                  render: (d) => (
                    <div className="ui-row">
                      <AsyncButton icon="open_in_new" onClick={() => openPdf(d)} onError={fail}>
                        Apri
                      </AsyncButton>
                      <AsyncButton icon="download" onClick={() => download(`/api/docs/${d.id}/file`, d.filename)} onError={fail}>
                        Scarica
                      </AsyncButton>
                      {isAdmin && <Button onClick={() => setEdit(d)}>Modifica</Button>}
                      {isAdmin && (
                        <AsyncButton variant="danger" onClick={() => remove(d)} onError={fail}>
                          Elimina
                        </AsyncButton>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          ) : (
            <EmptyState icon="library_books" title={filter ? 'Nessun documento trovato' : 'Nessun documento'}>
              {isAdmin ? 'Carica il primo PDF qui sopra.' : 'Gli amministratori non hanno ancora caricato documenti.'}
            </EmptyState>
          ))}
      </Card>
    </div>
  );
}
