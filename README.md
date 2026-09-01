# Acchiapparella — prototipo multiplayer

Piccolo gioco multiplayer in tempo reale: un cacciatore insegue, gli altri scappano.
Vedi `DESIGN.md` per il concept e le scelte di design.

## Come si gioca

Un cacciatore (rosso) insegue i fuggitivi (blu). Round da 45 secondi. Chi viene
toccato dal cacciatore è eliminato. Se il tempo scade prima che il cacciatore
prenda tutti, vincono i fuggitivi rimasti. Al round dopo il ruolo di cacciatore
passa a qualcun altro.

Muovi il tuo omino con le frecce o WASD.

## Avviarlo in locale

Serve [Node.js](https://nodejs.org) installato (versione 18 o successiva va bene).

```bash
cd omini-tag
npm install
npm start
```

Poi apri `http://localhost:3000` nel browser. Con un solo giocatore resti in
attesa ("waiting") — apri una seconda scheda (o fallo aprire a un'altra
persona) per far partire il primo round: servono almeno 2 giocatori connessi.

## Provarlo con gli amici sulla stessa rete Wi-Fi (nessun deploy)

1. Avvia il server come sopra sul tuo computer.
2. Trova il tuo indirizzo IP locale:
   - macOS/Linux: `ifconfig | grep inet` (o `ip addr` su Linux)
   - Windows: `ipconfig`, cerca "IPv4 Address" (es. `192.168.1.42`)
3. Gli amici, sulla stessa Wi-Fi, aprono `http://<il-tuo-ip>:3000` dal loro
   browser (anche da telefono).

Funziona solo mentre il tuo computer resta acceso e connesso, ed è limitato
a chi è sulla tua stessa rete — va benissimo per provarlo subito insieme,
ma per condividerlo davvero via link (anche a distanza) serve pubblicarlo,
vedi sotto.

## Pubblicarlo per condividere un link vero

Per un link che funziona per chiunque, non solo sulla tua Wi-Fi, serve un
hosting che tenga il server sempre acceso e supporti connessioni WebSocket
persistenti (necessarie per Socket.io). Due opzioni con un piano gratuito
adatte a un progetto così piccolo: [Render](https://render.com) e
[Railway](https://railway.app). In entrambe, a grandi linee: crei un account,
colleghi il repository (o carichi lo zip), imposti come comando di avvio
`npm start`, e il servizio ti dà un URL pubblico da mandare agli amici.
I dettagli esatti dei passaggi cambiano nel tempo, quindi conviene seguire
la guida "deploy a Node.js app" più recente sul sito che scegli.

## Struttura del progetto

```
omini-tag/
  server.js        # tutta la logica di gioco: stato, round, collisioni, timer
  package.json
  public/
    index.html      # schermata di join + canvas
    style.css
    client.js        # input da tastiera + disegno su canvas
DESIGN.md            # documento di design
```

Il server è "autoritativo": calcola lui posizioni, catture e timer, e manda
lo stato aggiornato a tutti i client 20 volte al secondo. I client mandano
solo i tasti premuti e disegnano quello che ricevono — è l'approccio più
semplice da capire per un primo gioco multiplayer, anche se non il più
ottimizzato per giochi con tantissimi giocatori o connessioni molto lente.

## Idee per continuare (vedi anche DESIGN.md)

- Respawn con invulnerabilità breve invece di eliminazione definitiva
- Torcia/visibilità limitata per il cacciatore
- Power-up temporanei (scatto, invisibilità)
- Punteggio che persiste tra round
- Arena e ostacoli diversi
