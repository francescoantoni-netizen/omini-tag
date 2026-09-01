# Acchiapparella — multiplayer 1v1 con account

Piccolo gioco multiplayer in tempo reale: un cacciatore insegue, l'altro scappa.
Vedi `DESIGN.md` per il concept e le scelte di design (comprese le versioni v2/v3
più recenti: partite 1v1 al meglio di 5 set, frutti, account e matchmaking).

## Come si gioca

Ti registri con username/email/password (email da confermare prima di poter
accedere), poi dalla lobby scegli se premere **"Trova avversario"** (ti mette
in coda finché non arriva qualcun altro in coda, come su un sito di scacchi) o
**invitare un amico specifico per username**. Ogni partita è 1 contro 1, al
meglio di 5 set (chi arriva a 3 set vinti vince): in ogni set un cacciatore
(rosso) insegue il fuggitivo (blu) per 45 secondi, i ruoli si scambiano sempre
da un set all'altro. In campo ci sono anche dei frutti 🍎: chi ne raccoglie uno
ottiene +20% di velocità per 5 secondi. Le tue partite vinte/perse restano
salvate sul tuo account.

Muovi il tuo omino con le frecce o WASD (su telefono, col joystick a schermo).

## Avviarlo in locale

Serve [Node.js](https://nodejs.org) (versione 18+) e un **database Postgres**
installato in locale (su Ubuntu/Debian: `sudo apt install postgresql`, poi
`sudo service postgresql start`).

```bash
cd omini-tag
npm install

# crea un utente/database Postgres per il gioco (una volta sola)
sudo -u postgres psql -c "CREATE USER ominitag WITH PASSWORD 'una-password-a-scelta';"
sudo -u postgres psql -c "CREATE DATABASE ominitag OWNER ominitag;"

# copia il file di esempio e personalizzalo se serve (di base punta già
# al database appena creato qui sopra)
cp .env.example .env

npm start
```

Poi apri `http://localhost:3000` nel browser. In locale, senza aver
configurato un provider email in `.env` (vedi sotto), le email di verifica
account e reset password **non vengono spedite davvero**: il link da
cliccare viene stampato nei log del server (il terminale dove hai lanciato
`npm start`) — copialo e incollalo nel browser per confermare l'account.
Comodo per sviluppare/testare senza dover configurare nulla.

Per giocare in due, apri il sito in due browser diversi (o uno normale e uno
in incognito) e registra due account diversi.

## Provarlo con gli amici sulla stessa rete Wi-Fi (nessun deploy)

1. Avvia il server come sopra sul tuo computer.
2. Trova il tuo indirizzo IP locale:
   - macOS/Linux: `ifconfig | grep inet` (o `ip addr` su Linux)
   - Windows: `ipconfig`, cerca "IPv4 Address" (es. `192.168.1.42`)
3. Gli amici, sulla stessa Wi-Fi, aprono `http://<il-tuo-ip>:3000` dal loro
   browser (anche da telefono) e si registrano.

Funziona solo mentre il tuo computer resta acceso e connesso, ed è limitato
a chi è sulla tua stessa rete — va benissimo per provarlo subito insieme,
ma per condividerlo davvero via link (anche a distanza) serve pubblicarlo,
vedi sotto.

## Pubblicarlo per condividere un link vero

Per un link che funziona per chiunque, non solo sulla tua Wi-Fi, adesso
servono **tre cose** (non solo l'hosting come nella prima versione):

1. **Un hosting Node.js sempre acceso**, con supporto WebSocket persistenti
   (necessarie per Socket.io) — es. [Render](https://render.com) o
   [Railway](https://railway.app). Il piano gratuito va bene per provare,
   ma "si addormenta" se resta inattivo: se vuoi che le partite/il login
   funzionino sempre senza attese, serve un piano a pagamento.
2. **Un database Postgres vero**, che sopravviva ai riavvii del server —
   quasi tutti gli hosting Node hanno un "add-on" Postgres con pochi click
   (Render, Railway), oppure puoi usarne uno gratuito indipendente come
   [Supabase](https://supabase.com) o [Neon](https://neon.tech). Il
   servizio ti dà una stringa di connessione: quella va nella variabile
   d'ambiente `DATABASE_URL` (vedi `.env.example`).
3. **Un modo per mandare email vere** (altrimenti nessuno può confermare
   l'account o resettare la password): la scelta più semplice è
   [Resend](https://resend.com) (piano gratuito generoso, ~5 minuti per
   attivarlo) — ti dà una `RESEND_API_KEY` da mettere nelle variabili
   d'ambiente. In alternativa un qualunque server SMTP (es. Gmail con una
   "App Password"). Tutti i dettagli sono commentati in `.env.example`.

In sintesi, sul pannello del tuo hosting imposti come comando di avvio
`npm start` e configuri queste variabili d'ambiente (mai il file `.env`
stesso, che è solo per lo sviluppo in locale e non va caricato su GitHub):
`DATABASE_URL`, `SESSION_SECRET` (una stringa lunga e casuale — vedi il
commento in `.env.example` per generarne una vera), `APP_BASE_URL` (il
dominio pubblico che ti dà l'hosting), e `RESEND_API_KEY`/`MAIL_FROM`
(oppure le variabili `SMTP_*`). Il servizio ti dà poi un URL pubblico da
mandare agli amici.

## Struttura del progetto

```
omini-tag/
  server.js        # Express + Socket.io: sessioni, presenza/lobby, matchmaking
  game.js           # la partita 1v1 vera e propria (una "Room" per ogni coppia
                     # che sta giocando in questo momento: arena, round/set,
                     # cattura, frutti — possono essercene tante in contemporanea)
  auth.js           # registrazione, verifica email, login/logout, reset password
  db.js             # connessione Postgres + schema delle tabelle
  mailer.js         # invio email (o stampa nei log in sviluppo)
  package.json
  .env.example      # copialo in .env per lo sviluppo locale
  public/
    index.html      # le tre schermate: login/registrazione, lobby, partita
    style.css
    client.js       # form di login/lobby, input da tastiera/joystick, disegno su canvas
DESIGN.md            # documento di design (concept, versioni v1/v2/v3)
```

Il server è "autoritativo": per ogni partita in corso calcola lui posizioni,
catture e timer, e manda lo stato aggiornato ai due giocatori di quella
partita 20 volte al secondo. I client mandano solo i tasti premuti e
disegnano quello che ricevono.

## Idee per continuare (vedi anche DESIGN.md)

- Classifica globale (chi ha vinto di più)
- Cronologia delle proprie partite giocate
- Rivincita immediata con lo stesso avversario a fine partita
- Matchmaking per livello di bravura (rating tipo Elo), invece della
  semplice coda "primo arrivato, primo servito"
- Respawn con invulnerabilità breve invece di eliminazione definitiva
- Torcia/visibilità limitata per il cacciatore
- Arena e ostacoli diversi
