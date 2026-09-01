// server.js — Acchiapparella multiplayer, prototipo
//
// Il server è "autoritativo": tiene lo stato vero del gioco (posizioni,
// ruoli, timer del round) e lo manda a tutti i client 20 volte al secondo.
// I client mandano solo "sto premendo questi tasti", non calcolano loro
// stessi dove si trovano gli altri giocatori. Questo evita che due browser
// vedano cose diverse ed è l'approccio più semplice da ragionare per un
// primo gioco multiplayer.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---- Costanti di design (vedi DESIGN.md) ----------------------------------
const ARENA_W = 800;
const ARENA_H = 600;
const PLAYER_RADIUS = 14;
const RUNNER_SPEED = 200;       // px al secondo
const HUNTER_SPEED = RUNNER_SPEED * 1.0; // nessun vantaggio di velocità: il vantaggio ora è tutto nel controllo
const CATCH_DISTANCE = PLAYER_RADIUS * 2;
const ROUND_DURATION_MS = 45 * 1000;
const COUNTDOWN_MS = 3 * 1000;
const RESULT_PAUSE_MS = 5 * 1000;
const TICK_MS = 50; // 20 aggiornamenti al secondo

// ---- Partita 1 contro 1, al meglio di 5 set ------------------------------
const SETS_TO_WIN = 3;              // chi arriva a 3 set vinti si aggiudica la partita
const MATCH_RESULT_PAUSE_MS = 7 * 1000; // pausa più lunga a fine PARTITA (non solo set), per far leggere bene il punteggio finale

// ---- Frutti con boost di velocità ------------------------------------
const FRUIT_RADIUS = 10;
const FRUIT_COUNT = 3;                // quanti frutti stanno in campo insieme
const FRUIT_BOOST_MULTIPLIER = 1.2;   // +20% velocità
const FRUIT_BOOST_DURATION_MS = 5 * 1000;
const FRUIT_RESPAWN_DELAY_MS = 4 * 1000; // dopo quanto ne spunta uno nuovo al posto di quello mangiato

const OBSTACLES = [
  { x: 150, y: 120, w: 120, h: 40 },
  { x: 520, y: 400, w: 140, h: 40 },
  { x: 340, y: 250, w: 40, h: 140 },
];

// ---- Stato del gioco --------------------------------------------------
// players: Map<socketId, { id, name, x, y, input, role, alive, order }>
const players = new Map();
let joinCounter = 0;

let phase = 'waiting'; // waiting | countdown | playing | ended
let phaseEndsAt = 0;
let roundEndsAt = 0;

// matchPlayerIds: i due id dei giocatori della partita 1v1 in corso (gli
// altri connessi restano spettatori). setScore: quanti set ha vinto
// ciascuno dei due nella partita attuale (si azzera a ogni nuova partita).
// lastHunterId: chi ha fatto il cacciatore nel set appena finito, per
// alternare sempre il ruolo al set successivo.
let matchPlayerIds = [];
let setScore = {};
let lastHunterId = null;

// fruits: [{ id, x, y }]. pendingFruitRespawns: timestamp a cui far
// ricomparire un frutto nuovo, uno per ogni frutto mangiato in attesa.
let fruits = [];
let fruitIdCounter = 0;
let pendingFruitRespawns = [];

function alivePlayers() {
  return [...players.values()].filter((p) => p.role !== 'spectator');
}

function connectedCount() {
  return players.size;
}

function pickMatchPlayers() {
  // i due giocatori connessi da più tempo (in ordine di ingresso) formano
  // la partita 1v1; chiunque altro resta spettatore in attesa che uno dei
  // due si scolleghi e liberi un posto.
  return [...players.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, 2)
    .map((p) => p.id);
}

function spawnPosition() {
  // punto casuale che non cade dentro un ostacolo
  for (let tries = 0; tries < 20; tries++) {
    const x = PLAYER_RADIUS + Math.random() * (ARENA_W - PLAYER_RADIUS * 2);
    const y = PLAYER_RADIUS + Math.random() * (ARENA_H - PLAYER_RADIUS * 2);
    if (!collidesWithObstacles(x, y)) return { x, y };
  }
  return { x: ARENA_W / 2, y: ARENA_H / 2 };
}

function collidesWithObstacles(x, y) {
  return OBSTACLES.some((o) => {
    const closestX = Math.max(o.x, Math.min(x, o.x + o.w));
    const closestY = Math.max(o.y, Math.min(y, o.y + o.h));
    const dx = x - closestX;
    const dy = y - closestY;
    return dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS;
  });
}

function spawnFruit() {
  for (let tries = 0; tries < 20; tries++) {
    const x = FRUIT_RADIUS + Math.random() * (ARENA_W - FRUIT_RADIUS * 2);
    const y = FRUIT_RADIUS + Math.random() * (ARENA_H - FRUIT_RADIUS * 2);
    if (!collidesWithObstacles(x, y)) {
      fruits.push({ id: fruitIdCounter++, x, y });
      return;
    }
  }
  fruits.push({ id: fruitIdCounter++, x: ARENA_W / 2, y: ARENA_H / 2 });
}

function resetFruits() {
  fruits = [];
  pendingFruitRespawns = [];
  for (let i = 0; i < FRUIT_COUNT; i++) spawnFruit();
}

function checkFruitPickups() {
  if (phase !== 'playing') return;
  const now = Date.now();
  const pickupRadius = PLAYER_RADIUS + FRUIT_RADIUS;
  for (const p of players.values()) {
    if (p.role === 'spectator' || !p.alive) continue;
    for (let i = fruits.length - 1; i >= 0; i--) {
      const f = fruits[i];
      const dx = p.x - f.x;
      const dy = p.y - f.y;
      if (dx * dx + dy * dy < pickupRadius * pickupRadius) {
        fruits.splice(i, 1);
        p.boostUntil = now + FRUIT_BOOST_DURATION_MS;
        pendingFruitRespawns.push(now + FRUIT_RESPAWN_DELAY_MS);
        io.emit('fruitEaten', { id: p.id, name: p.name });
      }
    }
  }
}

function startCountdown() {
  phase = 'countdown';
  phaseEndsAt = Date.now() + COUNTDOWN_MS;

  // Se non c'è già una partita in corso con entrambi i giocatori ancora
  // connessi (partita nuova, oppure quella precedente è appena finita a
  // 3 set), scegliamo chi gioca e ripartiamo da 0-0.
  const stillHere = matchPlayerIds.length === 2 && matchPlayerIds.every((id) => players.has(id));
  if (!stillHere) {
    matchPlayerIds = pickMatchPlayers();
    setScore = {};
    for (const id of matchPlayerIds) setScore[id] = 0;
    lastHunterId = null; // il primo cacciatore della partita si sceglie a caso
  }

  // Il cacciatore si alterna sempre da un set all'altro, indipendentemente
  // da chi ha vinto — così in una partita al meglio di 5 ognuno fa il
  // cacciatore circa la metà dei set. Al primo set della partita (nessun
  // "ultimo cacciatore" registrato) si sceglie a caso tra i due.
  let hunterId;
  if (lastHunterId != null && matchPlayerIds.includes(lastHunterId)) {
    hunterId = matchPlayerIds.find((id) => id !== lastHunterId);
  } else {
    hunterId = matchPlayerIds[Math.floor(Math.random() * matchPlayerIds.length)];
  }
  lastHunterId = hunterId;

  for (const p of players.values()) {
    if (!matchPlayerIds.includes(p.id)) {
      // chiunque non sia uno dei due giocatori della partita resta
      // spettatore, in attesa che si liberi un posto
      p.role = 'spectator';
      continue;
    }
    p.role = p.id === hunterId ? 'hunter' : 'runner';
    p.alive = true;
    const pos = spawnPosition();
    p.x = pos.x;
    p.y = pos.y;
    p.input = { up: false, down: false, left: false, right: false, vx: 0, vy: 0 };
    p.boostUntil = 0; // nessun boost residuo dal round precedente
  }

  resetFruits();
}

function startRound() {
  phase = 'playing';
  roundEndsAt = Date.now() + ROUND_DURATION_MS;
}

function endRound(winner) {
  phase = 'ended';
  fruits = [];
  pendingFruitRespawns = [];

  // "winner" è 'hunter' o 'runners': lo traduciamo nell'id del giocatore
  // vero che ha vinto QUESTO set, per aggiornare il punteggio della partita.
  const hunterId = matchPlayerIds.find((id) => players.get(id)?.role === 'hunter');
  const runnerId = matchPlayerIds.find((id) => id !== hunterId);
  const setWinnerId = winner === 'hunter' ? hunterId : runnerId;
  if (setWinnerId != null && setScore[setWinnerId] != null) {
    setScore[setWinnerId] += 1;
  }

  const matchWinnerId = matchPlayerIds.find((id) => (setScore[id] || 0) >= SETS_TO_WIN) || null;
  const matchOver = matchWinnerId != null;
  phaseEndsAt = Date.now() + (matchOver ? MATCH_RESULT_PAUSE_MS : RESULT_PAUSE_MS);

  io.emit('roundResult', {
    winner,
    winnerId: setWinnerId,
    score: matchPlayerIds.map((id) => ({
      id,
      name: players.get(id)?.name || '?',
      sets: setScore[id] || 0,
    })),
    matchOver,
    matchWinnerId,
    matchWinnerName: matchOver ? players.get(matchWinnerId)?.name || '?' : null,
  });

  if (matchOver) {
    // si riparte da 0-0: il prossimo startCountdown() sceglierà di nuovo i
    // due giocatori (gli stessi due se nessun altro è in attesa, altrimenti
    // si libera un posto per chi era spettatore)
    matchPlayerIds = [];
    setScore = {};
    lastHunterId = null;
  }
}

function movePlayer(p, dt) {
  if (phase !== 'playing' || p.role === 'spectator' || !p.alive) return;

  let dx, dy;
  if (p.input.vx !== 0 || p.input.vy !== 0) {
    // Input "analogico" (joystick touch sul telefono): il client manda
    // direttamente la direzione esatta verso cui hai spinto il dito,
    // come vettore (vx, vy) invece che 4 interruttori — per questo qui
    // il movimento può puntare in QUALSIASI angolo, non solo le 8
    // direzioni possibili con tastiera/TrackPoint.
    dx = p.input.vx;
    dy = p.input.vy;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; } // non superare la velocità massima
  } else {
    const { up, down, left, right } = p.input;
    dx = (right ? 1 : 0) - (left ? 1 : 0);
    dy = (down ? 1 : 0) - (up ? 1 : 0);
    if (dx !== 0 && dy !== 0) {
      // normalizza il movimento in diagonale, altrimenti si andrebbe più
      // veloci in diagonale che in linea retta
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }
  }

  const baseSpeed = p.role === 'hunter' ? HUNTER_SPEED : RUNNER_SPEED;
  const boosted = p.boostUntil && Date.now() < p.boostUntil;
  const speed = boosted ? baseSpeed * FRUIT_BOOST_MULTIPLIER : baseSpeed;
  const step = (speed * dt) / 1000;

  // muovi un asse alla volta, così scivoli lungo i muri/ostacoli invece di
  // restarci incollato
  const newX = clamp(p.x + dx * step, PLAYER_RADIUS, ARENA_W - PLAYER_RADIUS);
  if (!collidesWithObstacles(newX, p.y)) p.x = newX;

  const newY = clamp(p.y + dy * step, PLAYER_RADIUS, ARENA_H - PLAYER_RADIUS);
  if (!collidesWithObstacles(p.x, newY)) p.y = newY;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function checkCatches() {
  if (phase !== 'playing') return;
  const hunter = [...players.values()].find((p) => p.role === 'hunter');
  if (!hunter) return;

  let runnersLeft = 0;
  for (const p of players.values()) {
    if (p.role !== 'runner' || !p.alive) continue;
    const dx = p.x - hunter.x;
    const dy = p.y - hunter.y;
    if (dx * dx + dy * dy < CATCH_DISTANCE * CATCH_DISTANCE) {
      p.alive = false;
      io.emit('playerCaught', { id: p.id, name: p.name });
    } else {
      runnersLeft++;
    }
  }
  if (runnersLeft === 0) endRound('hunter');
}

// ---- Loop principale ----------------------------------------------------
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - lastTick;
  lastTick = now;

  if (phase === 'waiting') {
    if (connectedCount() >= 2) startCountdown();
  } else if (phase === 'countdown') {
    if (now >= phaseEndsAt) startRound();
  } else if (phase === 'playing') {
    for (const p of players.values()) movePlayer(p, dt);
    checkFruitPickups();
    checkCatches();
    if (phase === 'playing' && now >= roundEndsAt) endRound('runners');
  } else if (phase === 'ended') {
    if (now >= phaseEndsAt) {
      if (connectedCount() >= 2) startCountdown();
      else phase = 'waiting';
    }
  }

  // frutti mangiati che devono ricomparire: appena il loro momento arriva,
  // ne spunta uno nuovo altrove e lo togliamo dalla lista d'attesa
  pendingFruitRespawns = pendingFruitRespawns.filter((respawnAt) => {
    if (now < respawnAt) return true;
    spawnFruit();
    return false;
  });

  io.emit('state', {
    phase,
    timeLeft: phase === 'playing' ? Math.max(0, roundEndsAt - now) : null,
    countdownLeft: phase === 'countdown' ? Math.max(0, phaseEndsAt - now) : null,
    arena: { w: ARENA_W, h: ARENA_H, obstacles: OBSTACLES },
    fruits: fruits.map((f) => ({ id: f.id, x: f.x, y: f.y })),
    // punteggio della partita 1v1 in corso (null se al momento non c'è una
    // partita attiva, es. si è in attesa di un secondo giocatore)
    match: matchPlayerIds.length === 2
      ? {
          setsToWin: SETS_TO_WIN,
          players: matchPlayerIds.map((id) => ({
            id,
            name: players.get(id)?.name || '?',
            sets: setScore[id] || 0,
          })),
        }
      : null,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      role: p.role,
      alive: p.alive,
      boosted: !!(p.boostUntil && now < p.boostUntil),
    })),
  });
}, TICK_MS);

// ---- Connessioni Socket.io -----------------------------------------------
io.on('connection', (socket) => {
  socket.on('join', (name) => {
    const pos = spawnPosition();
    players.set(socket.id, {
      id: socket.id,
      name: String(name || 'Omino').slice(0, 16),
      x: pos.x,
      y: pos.y,
      input: { up: false, down: false, left: false, right: false, vx: 0, vy: 0 },
      role: 'spectator', // entra come spettatore, gioca dal round successivo
      alive: true,
      boostUntil: 0,
      order: joinCounter++,
    });
    socket.emit('joined', { id: socket.id });
  });

  socket.on('input', (input) => {
    const p = players.get(socket.id);
    if (!p || !input) return;
    p.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
      // vx/vy: direzione analogica dal joystick touch, un numero da -1 a 1
      // per asse. Validiamo che siano numeri veri (mai fidarsi di quello
      // che manda il client) e li teniamo dentro il range consentito.
      vx: typeof input.vx === 'number' ? clamp(input.vx, -1, 1) : 0,
      vy: typeof input.vy === 'number' ? clamp(input.vy, -1, 1) : 0,
    };
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    if (matchPlayerIds.includes(socket.id)) {
      // uno dei due giocatori della partita in corso se n'è andato: la
      // partita si interrompe qui, niente vincitore per abbandono. Se resta
      // qualcun altro in attesa, la prossima startCountdown() sceglie una
      // nuova coppia da zero.
      matchPlayerIds = [];
      setScore = {};
      lastHunterId = null;
      phase = 'waiting';
    } else if (connectedCount() < 2 && phase !== 'waiting') {
      phase = 'waiting';
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server pronto su http://localhost:${PORT}`);
});
