# Approvazioni dei PC

Modulo **spento di default** (Amministrazione → Funzionalità → «Approvazioni dei PC»).

Gli assistenti di programmazione lavorano sui PC con **Continuity**, nel fork indurito di CDA Net. Quando un assistente chiede il permesso per un comando, la richiesta arriva alla piattaforma. L'amministratore che possiede quel PC la **nega** con un tocco o la **consente**:
- dalla console (Amministrazione → **Approvazioni dei PC**), con un codice di verifica nuovo;
- dall'**app Android** (Rete → **Approvazioni dei PC**), con l'**impronta o il volto**, oppure con il codice.

```
PC (utente Windows dedicato agli assistenti)                     Piattaforma                        Admin
Continuity ←127.0.0.1→ agente ──HTTPS, in uscita──▶  /api/ai-agent/*  ◀── console / app ── nega · consenti (codice)
```

## Sicurezza

- **Il PC non apre porte.** L'agente si collega lui alla piattaforma, come il CRM interno con il token di servizio. Non servono VPN né port forwarding.
- **Il server non comanda il PC.** Non avvia sessioni, non manda prompt né comandi: può solo rispondere *sì* o *no* a una richiesta creata dall'agente. Anche con il server compromesso, il danno massimo è consentire un comando che l'assistente aveva già chiesto.
- **Comandi sensibili solo dal PC.** L'agente segna come «solo dal PC» quello che non si deve consentire da lontano: `git push` e `gh`, credenziali e `~/.ssh`, download da host sconosciuti, SSH verso gli apparati di rete. Da qui quei comandi si possono solo negare; la piattaforma rifiuta il «consenti» (`409 local_only`).
- **Dall'app con l'impronta.** Il telefono usa la chiave del suo accesso rapido, che il Keystore libera solo dopo un'impronta o un volto **forti**, e la manda con la decisione. Il server controlla che la chiave sia di quell'admin e del telefono, valida e **non** «persistente». Un telefono con accesso persistente (si apre senza impronta) o con una biometria debole deve usare il codice. Nel Registro la decisione è segnata «(impronta)» o «(codice)».
- **Conferma forte.** Negare: un tocco. Consentire: un **codice di verifica nuovo**, che vale una volta sola (anti-replay); va bene anche un codice di recupero. Dopo 5 codici sbagliati in 10 minuti si aspetta. Proprietario, stato e scadenza si controllano prima del codice, che non viene mai consumato per una decisione impossibile.
- **Solo il proprietario decide e legge.** Ogni agente appartiene all'admin che l'ha creato. Gli altri admin vedono che c'è una richiesta, ma non il testo del comando, e non decidono.
- **Scadenza.** Una richiesta senza risposta entro **10 minuti** vale «negata».
- **Testo dell'assistente.** Il comando arriva già ripulito dall'agente e il server lo ripulisce di nuovo: chiavi, token, password nelle opzioni e negli indirizzi diventano `[segreto]`. Al massimo 1.500 caratteri. Si mostra sempre come testo semplice, mai come HTML, con l'avviso che è scritto da un assistente e va letto prima di decidere.
- **Notifiche** (tipo «Approvazioni dei PC»): solo all'admin proprietario, in Notifiche, come push sull'app e sul Telegram personale se attivo. Contengono il nome del PC e dello strumento, **mai il comando**. Il gruppo del NOC non riceve niente.
- **Registro attività:**
  - creazione e revoca degli agenti (`ai.agent.*`);
  - decisioni (`ai.request.allow/deny`), con lo strumento e mai il comando completo.
- **Conservazione:** le richieste si cancellano dopo **30 giorni**.

## Agenti (i PC)

1. **Crea l'agente.** Approvazioni dei PC → «Collega un PC»: scrivi il nome del PC e un codice di verifica nuovo.
2. **Copia il token** `cdaagt_…`: si vede **una volta sola**.
   - Sul PC va nell'Archivio credenziali di Windows, mai in un file, in chat o in un repository.
   - Dura al massimo **90 giorni**.
   - Sul server resta solo l'impronta SHA-256.
3. **Quando cade:** il token smette di valere se l'admin viene disattivato, perde il ruolo, cambia password o toglie la verifica in due passaggi. Si revoca anche dalla lista «PC collegati»; le richieste in attesa diventano negate.
4. **Limiti:**
   - al massimo 5 agenti attivi per admin;
   - per agente, 20 richieste in attesa e 60 chiamate al minuto;
   - corpo di ogni chiamata fino a 16 KB.
5. **Nuovo agente:** il NOC riceve un avviso di sicurezza su Telegram.

## API

**Agente** (`Authorization: Bearer cdaagt_…`; con il modulo spento risponde `404 module_disabled`):

| Chiamata | Cosa |
|---|---|
| `POST /api/ai-agent/hello` | `{ version, sessions: [{ ref, goal, ai, state, project }] }`: stato ridotto delle sessioni (al massimo 20), per la console. |
| `POST /api/ai-agent/requests` | `{ ref, sessionRef?, ai?, tool, detail?, localOnly? }`, dove `ref` e `tool` sono identificativi (`[A-Za-z0-9_.:-]`); il comando va solo in `detail` → `{ id, ref, state, expiresAt }`. Lo stesso `ref` restituisce la stessa richiesta: l'agente può riprovare. |
| `GET /api/ai-agent/decisions?wait=25` | Attesa lunga, al massimo 25 secondi, e una sola alla volta per agente. Restituisce `{ decisions: [{ ref, allow, state }] }`. `expired` vale «no». Una decisione torna a ogni chiamata finché l'agente non la conferma, così una connessione caduta non la perde. |
| `POST /api/ai-agent/decisions/ack` | `{ refs: [...] }`: le decisioni applicate; da quel momento non tornano più. Un `401` vuol dire token non più valido: l'agente nega tutto quello che aspettava. |

**Amministratori** (verifica in due passaggi attiva):

| Chiamata | Cosa |
|---|---|
| `GET /api/admin/ai/agents` | PC, proprietario, stato, sessioni, richieste in attesa. |
| `POST /api/admin/ai/agents` | `{ name, code, days? }` → `{ id, name, token, expiresAt }`. |
| `DELETE /api/admin/ai/agents/:id` | Revoca. |
| `GET /api/admin/ai/requests?state=pending` | Richieste (`pending`, `allowed`, `denied`, `expired`). |
| `POST /api/admin/ai/requests/:id/decision` | `{ allow: false }`, `{ allow: true, code }` oppure dall'app `{ allow: true, device: { id, secret } }` (chiave dell'accesso rapido sbloccata dall'impronta). |

## Memorie di lavoro

Modulo a parte (**Memorie di lavoro**, spento di default). Le memorie di lavoro condivise dagli assistenti (profilo, decisioni, schede dei progetti, playbook per dominio) si scrivono e si rivedono in Git, nel repository privato `CDA-System-S-R-L/cdanet-as200034-continuity-hardened`, cartelle `cdanet/hub/memorie/` e `cdanet/hub/playbook/`. Il server le legge ogni ora e ne tiene una copia: in console (**Memorie di lavoro**, per chi ha visibilità piena) e per gli assistenti collegati con lo strumento MCP `memorie_cdanet`.

Regole:
- solo file `.md` in quelle due cartelle, al massimo 100 file da 64 KB;
- un file che sembra contenere un segreto o un dato personale (chiavi, token, password, IBAN, codice fiscale, email personali, telefoni) viene **scartato**: non arriva né in console né agli assistenti, e il NOC riceve un avviso con il solo percorso e il motivo, mai il contenuto. Sono le stesse regole di `cdanet/hub/strumenti/controlla-segreti.mjs`, che gira anche nella CI del repository;
- la copia si sostituisce tutta insieme; se GitHub non risponde resta quella di prima e la pagina mostra l'errore;
- il server non scrive mai nel repository.

### Il token (una volta, poi ogni anno)

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner**: l'organizzazione `CDA-System-S-R-L` (dal 27/11 il repository sta lì; il token del vecchio proprietario non vale più). **Repository access**: *Only select repositories* → solo `cdanet-as200034-continuity-hardened`.
3. **Permissions → Repository permissions → Contents: Read-only** (Metadata: Read-only si aggiunge da sola). Nient'altro.
4. Scadenza: al massimo un anno, con un promemoria in agenda.
5. Console → **Amministrazione → Funzionalità** → accendi **Memorie di lavoro**.
6. Console → **Memorie di lavoro**: incolla il token, scrivi un codice di verifica nuovo e premi **Prova e salva** (v1.42.1, serve per i server senza SSH).
   - GitHub prova subito il token sul repository: se lo rifiuta, non viene salvato.
   - Il token viene salvato **cifrato** con la chiave principale del server, come i token dei connettori, e **non si vede più**: si può solo sostituire o togliere.
   - Inserimento e rimozione finiscono nel Registro attività e arrivano al NOC sul canale sicurezza, mai con il token.
   - Si accettano solo token fine-grained (`github_pat_…`).

In alternativa, con l'accesso al server: nel file `.env` (mai in chat, mai in un repository) `AI_HUB_TOKEN=…`, poi `sudo cdanet-cpe up -d` (`restart` non rilegge il `.env`). Il token del `.env` **ha la precedenza** e dalla console non si può cambiare. Facoltativi `AI_HUB_REPO`, `AI_HUB_REF` (default `main`).

Se il token scade o viene revocato, la pagina dice «GitHub ha rifiutato il token»: la copia già letta resta disponibile.

| Chiamata | Cosa |
|---|---|
| `GET /api/admin/ai/memory` | Stato della lettura (commit, ora, errori, file scartati) ed elenco dei file. Visibilità piena. |
| `GET /api/admin/ai/memory/file?path=…` | Un file, come testo. Visibilità piena. |
| `POST /api/admin/ai/memory/refresh` | Rilegge adesso (admin, finisce nel Registro). |
| `PUT /api/admin/ai/memory/token` | `{ token, code }`: token dalla console, con un codice di verifica nuovo (admin). Provato su GitHub, poi salvato cifrato. `409` se il token è nel `.env`. |
| `DELETE /api/admin/ai/memory/token` | Toglie il token della console (admin). La copia già letta resta. |

## Privacy

Le richieste contengono il testo dei comandi chiesti dagli assistenti sui progetti, ripulito dei segreti. Non devono contenere dati dei clienti: il fork di Continuity tiene `.env`, credenziali, export degli apparati e dump dei database lontano dagli assistenti. La memoria dei comandi resta sul server per 30 giorni, poi si cancella.
