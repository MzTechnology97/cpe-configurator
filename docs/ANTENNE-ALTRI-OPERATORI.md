# Antenne altri operatori

Pagina della console per lo staff (amministratori, ufficio, specialisti): la mappa delle antenne (BTS) degli altri operatori, per capire chi copre una zona prima di un sopralluogo o di un'offerta. Modulo `operator_sites`, spento di default: si accende da **Funzionalità**.

## Da dove vengono i dati

| Fonte | Cosa dà | Quanto è precisa |
|---|---|---|
| **OpenCelliD** (dati aperti, licenza CC BY-SA 4.0) | Le celle delle reti scelte (di default WindTre, MNC 88 e 99, la rete di OpNet) dentro il riquadro scelto (di default la Sicilia). | La posizione è la media delle misure dei telefoni: può essere spostata di qualche centinaio di metri rispetto al traliccio vero. |
| **A mano** (amministratori) | I siti che conosciamo noi: sopralluoghi, clienti, tecnici. Serve per **Eolo**, che non pubblica le posizioni delle sue BTS. | Quella che inseriamo, con lo stato «da confermare» o «confermata». |

In parole semplici: un «sito stimato» è il punto dove i telefoni vedono più forti le celle di quell'operatore. Le celle a meno di 150 m l'una dall'altra diventano un solo sito, perché di solito stanno sullo stesso traliccio.

I dati scaricati restano nel database del server: mai nel repository, mai su un indirizzo pubblico. La pagina mostra la dicitura «© OpenCelliD, CC BY-SA 4.0», come chiede la licenza.

## Attivazione

1. Crea un account gratuito su opencellid.org e copia la chiave (Access Token).
2. Sul server, entra come root (`sudo -i`) e inserisci la chiave con questo blocco: la chiave non si vede mentre la incolli e non resta a schermo.

```bash
clear
cd /opt/cdanet-cpe
cp -a .env ".env.bak-$(date +%F-%H%M)"
read -rsp 'Chiave OpenCelliD: ' OCID </dev/tty; echo
grep -q '^OPENCELLID_TOKEN=' .env && sed -i "s|^OPENCELLID_TOKEN=.*|OPENCELLID_TOKEN=${OCID}|" .env || printf 'OPENCELLID_TOKEN=%s\n' "$OCID" >> .env
unset OCID
grep -q '^OPENCELLID_TOKEN=.\+' .env && echo 'Chiave scritta' || echo 'Chiave NON scritta'
```

3. Applica la modifica: `cdanet-cpe up -d` (ricrea il server con la chiave nuova).
4. In console: **Funzionalità** → accendi «Antenne altri operatori».
5. Apri **Antenne altri operatori** e premi **Aggiorna ora** (solo amministratori). Il download dura qualche minuto; poi si aggiorna da solo una volta alla settimana.

Facoltativo, nel `.env`:
- `OPENCELLID_NETS`: le reti da mostrare, `MNC:nome` separati da virgola (per esempio `88:WindTre,99:WindTre,50:Iliad`).
- `OPENCELLID_BBOX`: il riquadro `sud,ovest,nord,est` in gradi (di default `36.5,12.0,38.4,15.8`, la Sicilia).

## Errori

| Messaggio | Cosa fare |
|---|---|
| Manca la chiave | Inserirla con il blocco sopra. |
| Chiave rifiutata | Controllare la chiave su opencellid.org e reinserirla. |
| Limite giornaliero raggiunto | OpenCelliD permette pochi download al giorno: riprovare il giorno dopo. I siti di prima restano. |
| Reti o riquadro non validi | Correggere `OPENCELLID_NETS` o `OPENCELLID_BBOX`. |

## Cosa non c'è (ancora)

- **Le BTS di Eolo** non sono pubbliche: si vedono solo dal portale per i rivenditori. Si aggiungono a mano, oppure in un secondo momento dal portale, se CDA Net ha un account.
- **La copertura AGCOM per comune** (Broadband Map, dati aperti) arriverà quando avremo un file d'esempio per leggerne le colonne.
