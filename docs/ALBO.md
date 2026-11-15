# Albo e permessi (modulo, spento di default)

Richiesta di Carmelo del 15/11/2026. Per i comuni scelti dagli amministratori il server legge ogni ora:
- l'**albo pretorio online**;
- la pagina **Bandi di gara e contratti** di Amministrazione trasparente.

Tiene solo gli atti che parlano di reti: scavi per la fibra, antenne e stazioni radio base, telecomunicazioni, connettività. I nuovi arrivano al NOC.

## Da dove arrivano i dati

Non esiste un'API nazionale e non esiste un MCP per l'albo pretorio. Su PDND alcuni comuni pubblicano l'albo come e-service, ma sono una minoranza e ogni comune richiede un'adesione a parte. Per questo il modulo legge quello che ogni comune pubblica:
- **feed RSS o Atom**, se la piattaforma dell'albo lo offre. È la scelta migliore.
- **pagina elenco**: una riga della tabella è un atto, con l'oggetto e il primo link. Senza tabella si usano i link con un testo lungo.

Il server riconosce da solo se l'elenco è un feed o una pagina, e anche la codifica dei caratteri (UTF-8, ISO-8859-1, windows-1252). Raggiunge solo indirizzi pubblici, mai la rete interna, e controlla l'indirizzo anche dopo ogni reindirizzamento.

## Console → Albo e permessi

**Atti trovati** mostra quando è stato trovato ogni atto, il comune, il tipo, l'oggetto con il link e le parole trovate. Si filtra per tipo e per comune.

**Elenchi dei comuni** (solo admin) ha una riga per ogni elenco: comune, tipo (Albo pretorio o Bandi e contratti) e indirizzo.
- **Prova** mostra cosa si legge oggi e quali atti hanno le parole.
- **Pausa** sospende l'elenco.
- **Togli** lo elimina.

**Parole che fanno scattare l'avviso** (solo admin) ha una parola per riga, separata per Albo e per Bandi.
- La parola deve comparire intera: «tim» non trova «timbratura».
- Maiuscole e accenti non contano.
- Più parole di fila valgono insieme («stazione radio base»).

Le parole di serie coprono fibra, scavi, minitrincea, SRB, antenne, 5G e gli operatori (Open Fiber, FiberCop, Infratel, TIM, Vodafone, WindTre, Iliad, Eolo, INWIT). Per i bandi coprono connettività, Wi-Fi, rete dati, telefonia, VoIP e videosorveglianza.

**Controlla ora** (solo admin) fa subito il controllo.

## Avvisi

Al **primo controllo** di un elenco gli atti già pubblicati si salvano senza avvisi, per evitare decine di notifiche il giorno dell'aggiunta. Lo stesso vale quando cambia l'indirizzo di un elenco.

Da lì in poi ogni nuovo atto con le parole arriva:
- nella pagina **Notifiche** di ogni amministratore, con il tipo «Albo e permessi». Chi lo sceglie in Notifiche → Anche su Telegram (attivo di serie) lo riceve anche nella chat personale;
- al **gruppo Telegram del NOC**, con l'evento «Albo e permessi» in Connettori → Telegram.

In un controllo partono al massimo 12 avvisi; oltre quel numero ne arriva uno solo di riepilogo.

## Chi vede cosa

Sono dati di CDA Net:
- gli **amministratori** vedono gli atti e scelgono comuni, elenchi e parole;
- il **direttore tecnico** (Specialist con visibilità piena) vede gli atti e gli elenchi, ma non li cambia;
- **installatori** e **Specialist** senza visibilità piena non hanno accesso e ricevono 403.

## Conservazione e stato

- Gli atti con le parole restano un anno.
- Gli altri restano 90 giorni, solo per sapere che non sono nuovi.
- Salute piattaforma ha la riga **Albo e permessi (comuni)**: diventa rossa se un elenco non si legge. L'errore di ogni elenco è nella colonna Stato.

## API

- `GET /api/admin/albo?kind=&comune=&limit=`: configurazione, stato degli elenchi, atti trovati (chi vede tutto).
- `PUT /api/admin/albo/config` `{sources:[{id?,comune,kind,url,paused?}], keywords:{albo:[],bandi:[]}}` (admin).
- `POST /api/admin/albo/preview` `{url, kind}`: prova di un elenco (admin).
- `POST /api/admin/albo/check`: controllo subito (admin).

## Da fare dopo

- **Open data ANAC** (BDNCP) per i bandi, cercati per codice fiscale del comune. Oggi i bandi si leggono dalla pagina del comune.
- **SUAP** (impresainungiorno): ha il CAPTCHA, quindi non si legge in automatico.
