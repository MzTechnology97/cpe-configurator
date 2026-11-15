# Minacce (ransomware.live)

Modulo **Minacce** (chiave `threats`), spento di default. Lo vedono solo gli amministratori nella console, alla pagina **Minacce**. Serve al perimetro NIS2: tenere le schede degli asset, nostri e dei fornitori, e sapere subito se compaiono tra le vittime o negli indicatori dei gruppi ransomware.

## Attivazione

1. Il titolare crea la chiave API PRO dal suo profilo su ransomware.live.
2. La chiave va **solo** nel `.env` del server, come `RANSOMWARE_LIVE_API_KEY=…`. Poi si riavvia. Mai in chat, nei ticket o in un repository.
3. Accendi il modulo in Amministrazione → Funzionalità → «Minacce (ransomware.live)».
4. Gli avvisi su Telegram si scelgono come gli altri, in Notifiche → Anche su Telegram, e per il gruppo in Connettori → Telegram (evento «Minacce»).

`RANSOMWARE_LIVE_URL` cambia l'indirizzo dell'API. Il predefinito è `https://api-pro.ransomware.live`.

## Schede asset

Ogni scheda ha:
- **nome** e **tipo**: sistema, servizio, dominio e posta, fornitore, altro;
- **domini**, **IP** ed **email**, fino a 50 per tipo;
- note;
- la casella **«Cerca anche il nome tra le vittime»**, per le aziende e i fornitori. Il nome deve avere almeno 4 lettere e conta solo come parole intere.

Le schede possono essere al massimo 200. Un dominio, IP o email non valido viene rifiutato e indicato per nome.

## Il controllo (ogni giorno, e con «Controlla ora»)

- **Vittime:** per ogni dominio, e per ogni nome con la casella spuntata, il server chiede a ransomware.live `GET /victims/search?q=…`. Un riscontro vale solo se:
  - il sito della vittima è quel dominio o un suo sottodominio;
  - oppure il nome compare intero nel titolo.

  A ransomware.live escono **solo domini e nomi**, che sono dati pubblici.
- **Indicatori:** il server scarica gli indicatori di ogni gruppo (`GET /iocs`, poi `GET /iocs/{gruppo}`) e li confronta **sul server** con IP, domini ed email delle schede. IP ed email **non escono mai**.
- **Avvisi:** ogni riscontro nuovo arriva al NOC in Notifiche e su Telegram (personale e gruppo).
  - Al massimo 10 avvisi per controllo, poi un riepilogo.
  - Un riscontro già visto non torna.
  - Se la scheda viene eliminata, spariscono anche i suoi riscontri.
- **Salute della piattaforma:** il controllo compare come «Minacce (ransomware.live)». È in ritardo dopo 30 ore senza un controllo riuscito.
- **Errori:**
  - chiave mancante o rifiutata: il controllo si ferma e lo dice;
  - quota esaurita (HTTP 429): il controllo si ferma e lo dice;
  - una lettura non riuscita non ferma le altre.

Un riscontro va **verificato**. Se è confermato su un nostro sistema, si valuta la notifica al CSIRT secondo le procedure NIS2. Se riguarda un fornitore, si ruotano le credenziali condivise.

## Password (mai salvate)

Scelta di Carmelo del 15/11/2026: «Controllo all'inserimento, mai salvate».

Da una scheda, «Controlla password» chiede un nome (per esempio «admin router») e la password.
- Il server calcola lo SHA-1 e manda a Have I Been Pwned (`api.pwnedpasswords.com/range/…`, con padding) **solo i primi 5 caratteri**. Il confronto si fa sul server e la password si scarta.
- Restano solo il nome, l'esito (quante volte compare nelle liste rubate) e la data.
- La password non va nel Registro né nei log.
- Per ricontrollarla bisogna scriverla di nuovo.

ransomware.live non cerca email o password rubate: pubblica le aziende colpite e gli indicatori degli attaccanti.

## API (solo admin, modulo acceso)

- `GET /api/admin/threats` → `{ configured, status, assets, hits, passwordChecks }`
- `POST /api/admin/threats/assets` · `PUT /api/admin/threats/assets/:id` · `DELETE /api/admin/threats/assets/:id`: corpo `{ name, kind, searchName?, domains[], ips[], emails[], notes? }`
- `POST /api/admin/threats/check` → `{ at, ok, error?, assets, calls, fresh }`
- `POST /api/admin/threats/assets/:id/password` `{ label, password }` → `{ id, assetId, label, seen, checkedAt }`
- Eventi nel Registro: `threats.asset`, `threats.check`, `threats.password` (con nome ed esito, mai la password).

## Rete

Il server deve raggiungere `api-pro.ransomware.live` e `api.pwnedpasswords.com` in HTTPS. Le chiamate passano dalla stessa protezione delle altre letture esterne: solo indirizzi pubblici. Con la quota PRO (circa 500.000 chiamate al mese) un controllo al giorno con poche decine di schede resta molto sotto il limite.
