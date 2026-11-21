// Release gate: the rule «Stringhe vietate» (owner's decision of 21/11/2026, the same as the
// internal CRM). In the text of the repository there are no names of assistant tools or of their
// vendors, and no two-letter uppercase acronyms for artificial intelligence as whole words.
// Lowercase internal identifiers (ai_assistant, /api/ai-agent, ai-memory.ts) are not touched by the rule.
// The forbidden words are written in pieces here, so this file does not find itself.
//   node scripts/controlla-parole.mjs        → exit 1 with file:line for every hit
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  { name: 'strumenti di assistenza e produttori', re: new RegExp(['cla' + 'ude', 'anthr' + 'opic', 'open' + 'ai', 'chat' + 'gpt', 'gem' + 'ini', 'copi' + 'lot'].join('|'), 'i') },
  { name: 'sigle maiuscole', re: new RegExp('\\b(' + 'A' + 'I|' + 'I' + 'A)\\b') },
];
// binaries and pictures: the CRM checks pictures with OCR, outside this gate
const BINARY = /\.(png|jpe?g|webp|gif|ico|pdf|zip|gz|jar|apk|aab|keystore|jks|woff2?|ttf|otf|pmtiles|tiff?|bin|mbtiles|db|sqlite)$/i;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const hits = [];
for (const f of files) {
  for (const r of RULES) if (r.re.test(f)) hits.push(`${f}: nome del file (${r.name})`);
  if (BINARY.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;
  text.split('\n').forEach((line, i) => {
    for (const r of RULES) if (r.re.test(line)) hits.push(`${f}:${i + 1}: ${r.name}`);
  });
}
if (hits.length) {
  console.error(hits.join('\n'));
  console.error(`\n${hits.length} trovati: togli i nomi e le sigle vietate (regola «Stringhe vietate»).`);
  process.exit(1);
}
console.log(`regola dei nomi: 0 trovati su ${files.length} file`);
