import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { popup } from '../map/leaflet';
import { type LMap, MapView } from '../map/MapView';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * «Antenne altri operatori» (Carmelo 15/11/2026): the other operators' base stations on a map. The
 * WindTre cells (network of OpNet) are estimated from the open data of OpenCelliD (CC BY-SA 4.0);
 * the admins add by hand the sites they know (Eolo doesn't publish its BTS).
 */

type Status = 'stimata' | 'da confermare' | 'confermata';
interface Site {
  id: number;
  operator: string;
  source: 'opencellid' | 'manuale';
  lat: number;
  lon: number;
  radios: string[];
  cells: number;
  samples: number;
  rangeM: number;
  status: Status;
  note: string;
  updatedAt: string;
}
interface Run {
  at: string;
  ok: boolean;
  error?: string;
  lines: number;
  cells: number;
  sites: number;
  seconds: number;
}
interface Data {
  sites: Site[];
  truncated: boolean;
  summary: Array<{ operator: string; source: string; sites: number; cells: number }>;
  status: Run | null;
  configured: boolean;
  running: boolean;
  settings: { mcc: number; nets: Array<{ mnc: number; operator: string }>; bbox: { south: number; west: number; north: number; east: number } | null };
}
type View = { south: number; west: number; north: number; east: number };

const PALETTE = ['#e4572e', '#1e63d6', '#0f940f', '#8e44ad', '#d4a017', '#17a2b8', '#c0392b'];
const colorOf = (op: string, ops: string[]) => PALETTE[Math.max(0, ops.indexOf(op)) % PALETTE.length]!;
const ERRORS: Record<string, string> = {
  opencellid_token_missing: 'Manca la chiave OpenCelliD nel .env del server (OPENCELLID_TOKEN)',
  opencellid_token_refused: 'OpenCelliD ha rifiutato la chiave',
  opencellid_daily_limit: 'Limite giornaliero di OpenCelliD raggiunto: riprova domani',
  opencellid_settings_invalid: 'OPENCELLID_NETS o OPENCELLID_BBOX non validi nel .env',
  opencellid_not_gzip: 'OpenCelliD non ha mandato il file atteso',
  too_many_sites: 'Troppi siti aggiunti a mano (al massimo 2000)',
  site_not_found: 'Sito non trovato',
};
const say = (code?: string) => (code ? (ERRORS[code] ?? code) : '');
const date = (s: string) => new Date(s).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const STATUS_TONE: Record<Status, 'neutral' | 'warn' | 'good'> = { stimata: 'neutral', 'da confermare': 'warn', confermata: 'good' };

type Draft = { id?: number; operator: string; lat: string; lon: string; status: Status; note: string };
const EMPTY: Draft = { operator: 'Eolo', lat: '', lon: '', status: 'da confermare', note: '' };

export function OperatorSites({ user }: PageContext) {
  const isAdmin = user.role === 'admin';
  const [view, setView] = useState<View | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const mapRef = useRef<LMap | null>(null);
  const qs = view ? `?${new URLSearchParams({ south: view.south.toFixed(4), west: view.west.toFixed(4), north: view.north.toFixed(4), east: view.east.toFixed(4) })}` : '';
  const q = useQuery({
    queryKey: ['operator-sites', qs],
    queryFn: () => api<Data>(`/api/operator-sites${qs}`),
    enabled: view !== null,
    placeholderData: (prev) => prev,
    refetchInterval: (query) => ((query.state.data as Data | undefined)?.running ? 10_000 : false),
  });
  const manual = useQuery({ queryKey: ['operator-sites', 'manual'], queryFn: () => api<{ items: Site[] }>('/api/admin/operator-sites/manual'), enabled: isAdmin });
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = q.data;
  const operators = [...new Set((d?.summary ?? []).map((s) => s.operator))].sort((a, b) => a.localeCompare(b, 'it'));
  const shown = (d?.sites ?? []).filter((s) => !hidden.includes(s.operator));

  const importNow = async () => {
    await api('/api/admin/operator-sites/import', { method: 'POST' });
    toast('Aggiornamento avviato: ci vuole qualche minuto', 'good');
    setTimeout(() => void q.refetch(), 2000);
  };
  const save = async () => {
    if (!draft) return;
    const lat = Number(draft.lat.replace(',', '.'));
    const lon = Number(draft.lon.replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Coordinate non valide');
    const body = { operator: draft.operator.trim(), lat, lon, status: draft.status, note: draft.note };
    await api(draft.id ? `/api/admin/operator-sites/${draft.id}` : '/api/admin/operator-sites', { method: draft.id ? 'PUT' : 'POST', body });
    toast('Sito salvato', 'good');
    setDraft(null);
    await Promise.all([q.refetch(), manual.refetch()]);
  };
  const remove = async (s: Site) => {
    if (!window.confirm(`Eliminare il sito ${s.operator} (${s.lat}, ${s.lon})?`)) return;
    await api(`/api/admin/operator-sites/${s.id}`, { method: 'DELETE' });
    toast('Sito eliminato', 'good');
    await Promise.all([q.refetch(), manual.refetch()]);
  };
  const centre = () => {
    const c = mapRef.current?.getCenter();
    if (c && draft) setDraft({ ...draft, lat: c.lat.toFixed(6), lon: c.lng.toFixed(6) });
  };
  const fail = (e: unknown) => toast(say((e as Error).message) || (e as Error).message, 'bad');

  return (
    <>
      <PageHeader icon="cell_tower" title="Antenne altri operatori" subtitle="Dove sono le antenne (BTS) degli altri operatori: stimate dai dati aperti o aggiunte a mano" />
      {d && !d.configured && (
        <Notice tone="warn" title="Dati aperti non attivi">
          Manca la chiave gratuita di OpenCelliD nel .env del server (OPENCELLID_TOKEN). Si vedono solo i siti aggiunti a mano.
        </Notice>
      )}
      <Card
        title="Mappa"
        actions={
          <span className="ui-small ui-muted">
            {d ? `${shown.length} siti nella vista${d.truncated ? ' (avvicina la mappa per vederli tutti)' : ''}` : ''}
          </span>
        }
      >
        {operators.length > 1 && (
          <p className="ui-small">
            {operators.map((op) => (
              <label key={op} style={{ marginRight: 16 }}>
                <input type="checkbox" checked={!hidden.includes(op)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((x) => x !== op) : [...hidden, op])} />{' '}
                <span style={{ color: colorOf(op, operators), fontWeight: 600 }}>●</span> {op}
              </label>
            ))}
          </p>
        )}
        <MapView
          zoom={9}
          center={[37.45, 14.2]}
          tall
          fitMode="never"
          mapRef={mapRef}
          onReady={(map) => {
            const read = () => {
              const b = map.getBounds();
              setView({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
            };
            let t: ReturnType<typeof setTimeout> | undefined;
            map.on('moveend', () => {
              clearTimeout(t);
              t = setTimeout(read, 300);
            });
            read();
          }}
          deps={[shown, operators.join('|')]}
          draw={(target, L) =>
            shown.map((s) => {
              const color = colorOf(s.operator, operators);
              const est = s.source === 'opencellid';
              return L.circleMarker([s.lat, s.lon], { radius: est ? Math.min(9, 4 + s.cells / 3) : 8, color, weight: est ? 1 : 3, dashArray: s.status === 'da confermare' ? '3 3' : undefined, fillColor: color, fillOpacity: est ? 0.45 : 0.85 })
                .bindPopup(
                  popup(
                    `${s.operator} · ${s.status}`,
                    est ? `posizione stimata da ${s.cells} celle (${s.radios.join(', ') || '—'})` : 'aggiunto a mano',
                    est && s.rangeM ? `portata stimata della cella più ampia: ${(s.rangeM / 1000).toFixed(1)} km` : null,
                    s.note || null,
                    `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`,
                    `aggiornato ${date(s.updatedAt)}`,
                  ),
                )
                .addTo(target);
            })
          }
          legendItems={operators.map((op) => [colorOf(op, operators), op] as [string, string])}
        />
        <p className="ui-muted ui-small">
          I siti stimati sono la media delle misure dei telefoni: possono essere spostati di qualche centinaio di metri rispetto al traliccio vero. Bordo tratteggiato: da confermare. Dati delle celle © OpenCelliD, licenza CC BY-SA 4.0.
        </p>
      </Card>

      <Card
        title="Dati aperti (OpenCelliD)"
        actions={isAdmin && d?.configured ? <AsyncButton icon="refresh" onClick={importNow} onError={fail} disabled={d.running}>{d.running ? 'Aggiornamento in corso…' : 'Aggiorna ora'}</AsyncButton> : null}
      >
        {!d ? (
          <Skeleton />
        ) : (
          <>
            <p className="ui-small">
              Reti: {d.settings.nets.map((n) => `${n.operator} (MNC ${n.mnc})`).join(', ') || '—'} · riquadro{' '}
              {d.settings.bbox ? `${d.settings.bbox.south}, ${d.settings.bbox.west} → ${d.settings.bbox.north}, ${d.settings.bbox.east}` : 'non valido'} · aggiornamento automatico ogni settimana.
            </p>
            {d.status ? (
              <p className="ui-small">
                Ultimo aggiornamento {date(d.status.at)}:{' '}
                {d.status.ok ? (
                  <Badge tone="good">{`${d.status.sites} siti da ${d.status.cells} celle in ${d.status.seconds} s`}</Badge>
                ) : (
                  <Badge tone="bad">{say(d.status.error)}</Badge>
                )}
              </p>
            ) : (
              <p className="ui-small ui-muted">Mai aggiornato.</p>
            )}
            {d.summary.length > 0 && (
              <Table
                rows={d.summary}
                rowKey={(r) => `${r.operator}|${r.source}`}
                columns={[
                  { label: 'Operatore', render: (r) => <strong>{r.operator}</strong> },
                  { label: 'Fonte', render: (r) => (r.source === 'opencellid' ? 'dati aperti' : 'a mano') },
                  { label: 'Siti', render: (r) => r.sites },
                  { label: 'Celle', render: (r) => (r.source === 'opencellid' ? r.cells : '—') },
                ]}
              />
            )}
          </>
        )}
      </Card>

      {isAdmin && (
        <Card title="Siti aggiunti a mano" actions={!draft && <Button icon="add" onClick={() => setDraft({ ...EMPTY })}>Aggiungi sito</Button>}>
          <p className="ui-small ui-muted">Per gli operatori che non pubblicano le antenne (Eolo) o per correggere una posizione stimata. Visibili a tutto lo staff.</p>
          {draft && (
            <form onSubmit={(e) => e.preventDefault()}>
              <div className="ui-grid-2">
              <Field label="Operatore">
                <input maxLength={40} value={draft.operator} onChange={(e) => setDraft({ ...draft, operator: e.target.value })} />
              </Field>
              <Field label="Latitudine" hint="Gradi decimali, per esempio 37.45">
                <input inputMode="decimal" value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: e.target.value })} />
              </Field>
              <Field label="Longitudine" hint="Gradi decimali, per esempio 14.25">
                <input inputMode="decimal" value={draft.lon} onChange={(e) => setDraft({ ...draft, lon: e.target.value })} />
              </Field>
              <Field label="Stato">
                <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Status })}>
                  <option value="da confermare">Da confermare</option>
                  <option value="confermata">Confermata</option>
                  <option value="stimata">Stimata</option>
                </select>
              </Field>
              <Field label="Nota" hint="Da dove viene l'informazione (sopralluogo, cliente, tecnico)">
                <input maxLength={500} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              </Field>
              </div>
              <p>
                <Button variant="ghost" icon="my_location" onClick={centre}>Usa il centro della mappa</Button>{' '}
                <AsyncButton variant="primary" icon="save" onClick={save} onError={fail}>Salva</AsyncButton> <Button variant="ghost" onClick={() => setDraft(null)}>Annulla</Button>
              </p>
            </form>
          )}
          {manual.isLoading ? (
            <Skeleton />
          ) : !manual.data?.items.length ? (
            <EmptyState icon="cell_tower" title="Nessun sito aggiunto a mano" />
          ) : (
            <Table
              rows={manual.data.items}
              rowKey={(s) => s.id}
              columns={[
                { label: 'Operatore', render: (s) => <strong>{s.operator}</strong> },
                { label: 'Posizione', render: (s) => <span className="ui-mono ui-small">{`${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`}</span> },
                { label: 'Stato', render: (s) => <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge> },
                { label: 'Nota', render: (s) => <span className="ui-small">{s.note || '—'}</span> },
                {
                  label: '',
                  render: (s) => (
                    <>
                      <Button variant="ghost" icon="explore" onClick={() => mapRef.current?.setView([s.lat, s.lon], 15)}>Mappa</Button>
                      <Button variant="ghost" icon="edit" onClick={() => setDraft({ id: s.id, operator: s.operator, lat: String(s.lat), lon: String(s.lon), status: s.status, note: s.note })}>Modifica</Button>
                      <AsyncButton variant="ghost" icon="delete" onClick={() => remove(s)} onError={fail}>Elimina</AsyncButton>
                    </>
                  ),
                },
              ]}
            />
          )}
        </Card>
      )}
    </>
  );
}
