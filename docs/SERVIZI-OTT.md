# Servizi OTT e CDN

Il nostro «Downdetector», gratuito. Pagina della console per lo staff (amministratori, ufficio, specialisti). Si attiva con il modulo `ott_monitor`, spento di default, dalla pagina **Funzionalità**.

## Perché

Quando un cliente chiama e dice «Netflix non va», serve sapere subito se il guasto è nostro o di Netflix. Downdetector raccoglie le segnalazioni degli utenti, ma non ha un servizio gratuito da collegare, e copiare il suo sito non è permesso. Per questo usiamo due fonti gratuite e pulite.

| Fonte | Ogni quanto | Cosa dice |
|---|---|---|
| **Le nostre prove** | 1 minuto | Il server apre il servizio dalla nostra rete, come farebbe un cliente: nome a dominio, collegamento e prima risposta. Misura quanto ci mette. |
| **Pagine di stato ufficiali** | 5 minuti | Quello che il servizio dichiara, dove lo pubblica in un formato aperto: Statuspage (Cloudflare, Akamai, Fastly, GitHub, Discord, Zoom, Dropbox) e Google. |

Il server apre solo l'indirizzo pubblico del servizio. Non invia nessun dato dei clienti e non ha bisogno di chiavi.

## Come si legge

- **Regolare**: risponde come al solito.
- **Lento**: le ultime due prove buone sono state più di 3 volte più lente del solito, e oltre 1,5 secondi. «Il solito» è la mediana delle risposte del giorno prima.
- **Irraggiungibile**: le ultime 3 prove di fila sono fallite (una prova persa non è un guasto).
- **Pagina ufficiale**: «nessun problema», «problema minore», «guasto grave» o «manutenzione». Se il servizio non ha una pagina pubblica in formato aperto, la colonna dice «non pubblica».
- **Il grafico**: i tempi di risposta delle ultime 24 ore, a blocchi di 15 minuti. Le bande rosse sono le prove fallite.

La regola d'oro: **se più di metà dei servizi è irraggiungibile insieme, il problema è nostro** (transito, DNS, router di bordo). In quel caso la pagina mostra un avviso rosso e il NOC riceve un solo messaggio, non uno per servizio.

## Avvisi

Gli avvisi arrivano al NOC nella pagina **Notifiche** e su Telegram, con l'evento «Servizi OTT e CDN» acceso in Connettori → Telegram. Partono quando:
- un servizio diventa irraggiungibile o lento, e quando torna normale;
- la pagina ufficiale dichiara un guasto grave, e quando lo chiude;
- molti servizi cadono insieme, e quando l'uscita torna normale.

Ogni giro manda al massimo 10 avvisi.

## Servizi

Al primo avvio la lista ha 28 servizi:
- streaming: YouTube, Netflix, Prime Video, Disney+, DAZN, RaiPlay, Mediaset Infinity, Spotify, Twitch;
- social: WhatsApp, Facebook, Instagram, TikTok, Discord;
- cloud e lavoro: Google, Microsoft 365, Teams, Zoom, iCloud, Dropbox, GitHub;
- giochi: PlayStation, Xbox, Steam;
- CDN: Cloudflare, Akamai, Fastly, AWS.

Gli amministratori aggiungono, modificano, spengono o tolgono i servizi dalla pagina (al massimo 80). Per aggiungerne uno servono:
- il nome;
- la categoria;
- l'indirizzo che apre un cliente;
- se c'è, la pagina di stato:
  - **Statuspage**: si scrive solo l'indirizzo base, il server aggiunge `/api/v2/summary.json`;
  - **Google**: l'indirizzo completo di `incidents.json`.

Le prove degli ultimi 2 giorni restano nel database del server, poi si cancellano da sole.
