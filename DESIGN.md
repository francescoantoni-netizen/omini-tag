# Acchiapparella — documento di design (v1, prototipo)

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
