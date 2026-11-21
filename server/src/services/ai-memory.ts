import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * «Memorie di lavoro» (module ai_memory): the shared work memories of the AIs live in Git, in a private
 * repository, and are reviewed there. The server reads them every hour with a fine-grained GitHub
 * token that can only READ that repository, keeps a copy, and shows them in the console and to
 * the assistants (MCP tool memorie_cdanet). Only Markdown in the two folders below; a file that looks like
 * it holds a secret or personal data is refused and the NOC hears of it.
 *
 * The token comes from the server's .env (AI_HUB_TOKEN, it wins) or from the console (v1.42.1, for
 * servers without SSH): an admin with a fresh code pastes it, it is sealed with the master key like
 * the connectors' tokens, never shown again, only replaced or removed. Only fine-grained tokens.
 */
export const MEMORY_DIRS = ['cdanet/hub/memorie/', 'cdanet/hub/playbook/'];
const MAX_FILES = 100;
const MAX_BYTES = 64 * 1024;
const HOUR = 3_600_000;
const TOKEN_KEY = 'ai_memory_token';
/** Fine-grained personal access tokens only: they can be limited to one repository and to reading. */
export const HUB_TOKEN_RE = /^github_pat_[A-Za-z0-9_]{40,250}$/;

/** Same rules as the repository's own check (cdanet/hub/strumenti/controlla-segreti.mjs). */
export const MEMORY_RULES: Array<[string, RegExp]> = [
  ['chiave privata', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['token GitHub', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['token GitLab', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['chiave di un servizio', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/],
  ['token della piattaforma', /\b(cdasvc|cdaagt|crmsvc)_[A-Za-z0-9_-]{16,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['password in chiaro', /\b(password|passwd|pwd|psk|secret|segreto|community)\s*[:=]\s*["']?(?!\*|<|\$\{|x{3,})[^\s"'`]{6,}/i],
  ['URL con credenziali', /\b[a-z]+:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['IBAN', /\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/],
  ['codice fiscale', /\b[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]\b/],
  ['email personale', /\b[A-Za-z0-9._%+-]+@(gmail|hotmail|outlook|libero|yahoo|icloud|virgilio|tiscali)\.[a-z]{2,}\b/i],
  ['telefono', /(?<![\w.])(\+39\s?)?3\d{2}[\s.-]?\d{6,7}(?![\w.])/],
];

export function memoryProblem(text: string): string | null {
  for (const [what, re] of MEMORY_RULES) if (re.test(text)) return what;
  return null;
}

export interface MemoryState {
  commit: string | null;
  at: string | null;
  ok: boolean;
  error: string | null;
  skipped: Array<{ path: string; reason: string }>;
  count: number;
  configured: boolean;
  /** Where the token comes from: the server's .env, the console, or nowhere. */
  tokenSource: 'env' | 'console' | null;
  tokenSetAt: string | null;
  tokenSetBy: string | null;
  repo: string;
  ref: string;
}

const titleOf = (md: string, path: string) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim().slice(0, 120) ?? path.split('/').pop()!.replace(/\.md$/, '');

export function createAiMemory(
  db: Db,
  sealer: Sealer,
  o: {
    hub: { token: string | undefined; repo: string; ref: string; api: string };
    isOn: () => boolean;
    /** A file refused for a possible secret: to the NOC (Telegram security), without the content. */
    alert: (text: string) => void;
    fetchImpl?: typeof fetch;
    log?: (m: string) => void;
  },
) {
  const f = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<MemoryState> | null = null;

  function stored(): { sealed: string; at: string; by: string } | null {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_KEY) as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as { sealed: string; at: string; by: string }) : null;
    } catch {
      return null;
    }
  }
  /** The token in use: the .env first, then the one from the console. Never leaves this file. */
  function token(): string | undefined {
    if (o.hub.token) return o.hub.token;
    const s = stored();
    if (!s) return undefined;
    try {
      return sealer.open(s.sealed);
    } catch {
      return undefined;
    }
  }

  function state(): MemoryState {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'ai_memory_state'").get() as { value: string } | undefined;
    let s: Partial<MemoryState> = {};
    try {
      s = r ? (JSON.parse(r.value) as Partial<MemoryState>) : {};
    } catch {}
    const count = (db.prepare('SELECT COUNT(*) n FROM ai_memory_files').get() as { n: number }).n;
    const t = o.hub.token ? null : stored();
    return {
      commit: s.commit ?? null,
      at: s.at ?? null,
      ok: s.ok ?? false,
      error: s.error ?? null,
      skipped: s.skipped ?? [],
      count,
      configured: !!token(),
      tokenSource: o.hub.token ? 'env' : t ? 'console' : null,
      tokenSetAt: t?.at ?? null,
      tokenSetBy: t?.by ?? null,
      repo: o.hub.repo,
      ref: o.hub.ref,
    };
  }
  function save(s: Pick<MemoryState, 'commit' | 'at' | 'ok' | 'error' | 'skipped'>) {
    db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('ai_memory_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(s), nowIso());
  }

  async function gh(path: string, tk = token()): Promise<unknown> {
    const res = await f(`${o.hub.api.replace(/\/$/, '')}${path}`, {
      headers: { authorization: `Bearer ${tk}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'cdanet-cpe-server' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    // the token never goes into an error message
    if (res.status === 401 || res.status === 403) throw new Error(`GitHub ha rifiutato il token (${res.status}): controlla scadenza e permessi`);
    if (res.status === 404) throw new Error('Repository o ramo non trovato (o il token non lo vede)');
    if (!res.ok) throw new Error(`GitHub ha risposto ${res.status}`);
    const text = await res.text();
    if (text.length > 4_000_000) throw new Error('Risposta di GitHub troppo grande');
    return JSON.parse(text);
  }

  const repoPath = () => o.hub.repo.split('/').map(encodeURIComponent).join('/');

  async function refreshNow(force: boolean): Promise<MemoryState> {
    if (!token()) return state();
    const prev = state();
    try {
      const repo = repoPath();
      const commit = ((await gh(`/repos/${repo}/commits/${encodeURIComponent(o.hub.ref)}`)) as { sha?: string }).sha;
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('Commit non valido');
      if (!force && commit === prev.commit && prev.ok) {
        save({ commit, at: nowIso(), ok: true, error: null, skipped: prev.skipped });
        return state();
      }
      const tree = (await gh(`/repos/${repo}/git/trees/${commit}?recursive=1`)) as { tree?: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean };
      const wanted = (tree.tree ?? [])
        .filter((e) => e.type === 'blob' && MEMORY_DIRS.some((d) => e.path.startsWith(d)) && /\.md$/i.test(e.path) && !e.path.includes('..'))
        .slice(0, MAX_FILES);
      const skipped: MemoryState['skipped'] = [];
      const keep: Array<{ path: string; sha: string; size: number; title: string; content: string }> = [];
      for (const e of wanted) {
        if ((e.size ?? 0) > MAX_BYTES) {
          skipped.push({ path: e.path, reason: 'file troppo grande' });
          continue;
        }
        const blob = (await gh(`/repos/${repo}/git/blobs/${e.sha}`)) as { content?: string; encoding?: string };
        const content = blob.encoding === 'base64' ? Buffer.from(blob.content ?? '', 'base64').toString('utf8') : String(blob.content ?? '');
        const problem = memoryProblem(content);
        if (problem) {
          skipped.push({ path: e.path, reason: `possibile ${problem}` });
          continue;
        }
        keep.push({ path: e.path, sha: e.sha, size: Buffer.byteLength(content), title: titleOf(content, e.path), content });
      }
      // replaced all together: never half old and half new
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM ai_memory_files').run();
        const ins = db.prepare('INSERT INTO ai_memory_files(path, sha, size, title, content, fetched_at) VALUES(?,?,?,?,?,?)');
        for (const k of keep) ins.run(k.path, k.sha, k.size, k.title, k.content, nowIso());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const fresh = skipped.filter((s) => !prev.skipped.some((p) => p.path === s.path && p.reason === s.reason));
      if (fresh.length) o.alert(`Memorie di lavoro: ${fresh.length} file scartati per possibili segreti o dati personali (${fresh.map((s) => `${s.path}: ${s.reason}`).join('; ').slice(0, 600)}). Correggili nel repository.`);
      save({ commit, at: nowIso(), ok: true, error: tree.truncated ? 'Elenco dei file tagliato da GitHub' : null, skipped });
      log(`ai memory: ${keep.length} file, ${skipped.length} scartati, commit ${commit.slice(0, 7)}`);
    } catch (e) {
      // the copy already there stays usable; the error is shown
      save({ commit: prev.commit, at: nowIso(), ok: false, error: (e as Error).message.slice(0, 200), skipped: prev.skipped });
    }
    return state();
  }

  return {
    state,
    list: () =>
      db.prepare('SELECT path, title, size, sha FROM ai_memory_files ORDER BY path').all() as Array<{ path: string; title: string; size: number; sha: string }>,
    read: (path: string) =>
      (db.prepare('SELECT path, title, size, sha, content, fetched_at fetchedAt FROM ai_memory_files WHERE path = ?').get(path) as
        | { path: string; title: string; size: number; sha: string; content: string; fetchedAt: string }
        | undefined) ?? null,
    /**
     * The token from the console: tried on the repository first (a token GitHub refuses is never
     * saved), then sealed. Refused while the .env has one: that one wins and is changed there.
     */
    async setToken(value: string, by: string) {
      if (o.hub.token) throw new Error('env');
      if (!HUB_TOKEN_RE.test(value)) throw new Error('format');
      // the same call as a reading: the repository and the branch must be visible with this token
      await gh(`/repos/${repoPath()}/commits/${encodeURIComponent(o.hub.ref)}`, value);
      db.prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
        TOKEN_KEY,
        JSON.stringify({ sealed: sealer.seal(value), at: nowIso(), by }),
        nowIso(),
      );
      o.alert(`Memorie di lavoro: token GitHub inserito dalla console da ${by}.`);
    },
    /** The copy already read stays; the next readings stop until a new token. */
    clearToken(by: string) {
      if (o.hub.token) throw new Error('env');
      const had = db.prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY).changes > 0;
      if (had) o.alert(`Memorie di lavoro: token GitHub tolto dalla console da ${by}.`);
      return had;
    },
    /** One reading at a time; [force] reads every file even if the commit did not change. */
    refresh(force = false) {
      running ??= refreshNow(force).finally(() => (running = null));
      return running;
    },
    start() {
      if (timer) return;
      // armed even without a token: it can arrive from the console
      const tick = () => {
        if (o.isOn() && token()) void this.refresh(false).catch(() => {});
      };
      setTimeout(tick, 60_000).unref?.();
      timer = setInterval(tick, HOUR);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
export type AiMemory = ReturnType<typeof createAiMemory>;
