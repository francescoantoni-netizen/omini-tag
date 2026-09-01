# Acchiapparella — documento di design (v1, prototipo)

## Aggiornamento v2: 1 contro 1, al meglio di 5 set + frutti

Rispetto al v1 descritto qui sotto (pensato per un gruppo 3-8 persone con un
solo cacciatore e tutti gli altri fuggitivi), il gioco ora funziona a
**partite 1 contro 1**:

- Ogni **set** dura al massimo 45 secondi, con le stesse regole di cattura
  del v1 (cacciatore tocca il fuggitivo → cacciatore vince il set; tempo
  scaduto → vince il fuggitivo).
- Il ruolo di cacciatore **si alterna sempre** da un set all'altro tra i due
  giocatori, indipendentemente da chi ha vinto — equità garantita invece
  che affidata alla rotazione su un gruppo più grande.
- Vince la **partita** chi arriva per primo a **3 set vinti** (al meglio di
  5: il punteggio finale può essere 3-0, 3-1 o 3-2).
- Sono stati aggiunti dei **frutti** raccoglibili in campo (+20% velocità
  per 5 secondi) come primo power-up del gioco.
- Se una terza persona si collegava mentre due stavano già giocando,
  restava spettatrice finché non si liberava un posto — non c'era ancora un
  vero sistema di coda/matchmaking. **Superato dal v3 qui sotto**, che
  aggiunge login utente, coda automatica/inviti diretti e statistiche
  persistenti.

## Aggiornamento v3: account, statistiche persistenti, matchmaking

Rispetto al v2 (dove chiunque si collegava finiva nella stessa arena
condivisa), il gioco ora funziona **come un sito di scacchi**:

- **Account veri**: username + email + password, con conferma email
  obbligatoria prima di poter accedere e un flusso completo di "password
  dimenticata". Le password non sono mai salvate in chiaro (solo il loro
  hash bcrypt), i token di verifica/reset scadono e sono usa-e-getta.
- **Statistiche persistenti**: partite vinte/perse e set vinti/persi
  restano sull'account tra una sessione e l'altra, salvati in un database
  Postgres vero (non più in memoria: sopravvivono a un riavvio/redeploy del
  server).
- **Matchmaking**: dalla lobby si preme "Trova avversario" per entrare in
  una coda FIFO (il primo che aspetta è il primo ad essere accoppiato con
  chi arriva dopo), oppure si invita un amico specifico digitando il suo
  username — lui riceve l'invito in tempo reale e può accettare o
  rifiutare.
- **Partite multiple in contemporanea**: non c'è più un'unica arena
  condivisa da tutti i connessi. Ogni coppia che sta giocando ha la propria
  "Room" indipendente (il termine tecnico è in `game.js`), con il proprio
  arbitro/timer — proprio come un sito di scacchi gestisce tante partite
  insieme, non solo una alla volta. Chi è collegato ma non sta giocando (in
  coda, o semplicemente in lobby) non fa parte di nessuna Room.

### Cosa resta fuori anche da v3 (di proposito)

Per tenere lo scope gestibile restano fuori: matchmaking per livello di
bravura (un rating tipo Elo, invece della semplice coda FIFO), una
classifica globale, la cronologia delle singole partite giocate (si vede
solo il totale aggregato vinte/perse), il supporto a più dispositivi
collegati con lo stesso account in contemporanea (l'ultimo collegamento
"scollega" il precedente), e la ripresa automatica di una partita
interrotta da una disconnessione (se un giocatore si scollega a metà
partita, la partita finisce lì senza vincitore/punteggio registrato). Sono
tutte estensioni naturali del sistema di account/matchmaking appena
descritto.

## Concept

Piccolo gioco multiplayer in tempo reale da giocare nel browser con gli amici, senza installazioni: si apre un link e si è subito in partita. Obiettivo del progetto: imparare le basi dello sviluppo di un gioco (loop, stato condiviso, sincronizzazione in tempo reale) partendo da qualcosa di volutamente semplice.

Genere: acchiapparella (tag) con ruoli fissi per round — un cacciatore insegue, tutti gli altri fuggono.

## Il loop

1. **Inizio round** — il server assegna un giocatore come cacciatore, tutti gli altri sono fuggitivi.
2. **Movimento libero** — i fuggitivi scappano, il cacciatore insegue, tutti si muovono liberamente nell'arena.
3. **Cattura** — se il cacciatore tocca un fuggitivo, quel fuggitivo è eliminato ed esce dal round (resta a guardare gli altri fino alla fine).
4. **Fine round** — il round finisce quando scade il tempo (vincono i fuggitivi rimasti) oppure quando sono stati presi tutti (vince il cacciatore).
5. **Rotazione** — al round successivo il ruolo di cacciatore passa a un altro giocatore del gruppo, così tutti provano entrambi i ruoli nel corso di una serata.

## Regole del prototipo (v1)

Queste sono le scelte di default per il primo prototipo giocabile — facili da cambiare in seguito.

- **Cattura → eliminazione**: chi viene preso resta fuori fino a fine round (nessun respawn in v1).
- **Durata round**: 45 secondi.
- **Arena**: piccola, con un paio di ostacoli semplici (rettangoli) dietro cui nascondersi/rompere la linea di inseguimento.
- **Vantaggio del cacciatore**: velocità di movimento +20% rispetto ai fuggitivi (senza questo vantaggio il cacciatore fatica troppo a prendere qualcuno e il round non finisce mai).
- **Numero giocatori**: pensato per un piccolo gruppo di amici (indicativamente 3-8).

## Cosa NON c'è in v1 (di proposito)

Per tenere lo scope realistico per un primo progetto, restano fuori: power-up, punteggio persistente tra serate, chat in-game, visibilità limitata/torcia, territorio, zona che si restringe. Sono tutte estensioni naturali una volta che il loop base funziona bene — vedi sezione "Possibili estensioni" sotto.

## Stack tecnico

- **Server**: Node.js + Express (serve i file statici del client) + Socket.io (sincronizza posizioni, ruoli, stato del round tra tutti i giocatori connessi).
- **Client**: HTML5 + Canvas 2D + JavaScript semplice (nessun framework), disegna l'arena e gli omini a ogni frame in base allo stato ricevuto dal server.
- **Distribuzione**: il gioco vive dietro un link — gli amici lo aprono nel browser (anche da telefono), zero installazioni. Per farlo funzionare in modo affidabile per tutti (indipendentemente da router/reti particolari) si usa un piccolo server relay via Socket.io invece di connessioni dirette peer-to-peer tra browser.
- **Hosting per condividerlo davvero**: un servizio gratuito con supporto WebSocket persistenti, ad es. Render o Railway (free tier). In locale (stessa rete Wi-Fi) basta invece l'IP del computer che fa da server.

## Perché queste scelte

Il gioco è deliberatamente "solo movimento sincronizzato": niente sistemi aggiuntivi (griglia da colorare, visibilità limitata, timer di restringimento) in questa prima versione, così la difficoltà tecnica resta concentrata su un'unica cosa — muovere gli omini in modo fluido e coerente per tutti i giocatori collegati — invece di essere distribuita su più meccaniche insieme. Una volta che questa parte gira bene, le estensioni sotto si aggiungono senza dover ripensare la base.

## Possibili estensioni (dopo il prototipo)

- Respawn con breve invulnerabilità invece di eliminazione definitiva
- Torcia/visibilità limitata per il cacciatore (variante "nascondino")
- Power-up temporanei (scatto, invisibilità breve)
- Punteggio che persiste tra round/serate
- Arena più grande con più ostacoli, o forme diverse
