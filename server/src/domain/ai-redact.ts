/**
 * «Assistente AI»: the text of a permission request is written by an AI on a PC and may carry a
 * secret it read (a key in a command line, a URL with a password). The agent on the PC already
 * cleans it; the server cleans it again before storing or showing it, and cuts it short.
 */
const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[chiave privata]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[token]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[token]'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g, '[chiave]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[chiave]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[chiave]'],
  [/\b(cdasvc|cdaagt)_[A-Za-z0-9_-]{16,}/g, '[token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [segreto]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[credenziali]@'],
  // variables like PGPASSWORD=, GITHUB_TOKEN=, AWS_SECRET_ACCESS_KEY=, DB_PASS=, MYSQL_PWD=
  [/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s"'`;&|]+)/gi, '$1[segreto]'],
  // curl -u user:pass, mysql -pSecret, sshpass -p secret, Authorization: token …
  [/(\s-u\s+)[^\s:]+:\S+/g, '$1[credenziali]'],
  [/(\bmysql(?:dump)?\b[^\n]*?\s-p)(?!\s)\S+/gi, '$1[segreto]'],
  [/(\bsshpass\s+-p\s*)\S+/gi, '$1[segreto]'],
  [/\b(Authorization:\s*(?:token|Bearer|Basic)\s+)\S+/gi, '$1[segreto]'],
  [/(--?(?:password|passwd|pass|token|secret|api[-_]?key|community)[= ])("[^"]*"|'[^']*'|[^\s"'`,;]+)/gi, '$1[segreto]'],
  [/\b(password|passwd|pwd|psk|secret|segreto|token|api[-_]?key|community)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"'`,;]+)/gi, '$1$2[segreto]'],
];

export function redactAi(text: string, max = 1500): string {
  let s = String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const [re, by] of RULES) s = s.replace(re, by);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
