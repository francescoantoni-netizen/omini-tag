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
const HUNTER_SPEED = RUNNER_SPEED * 1.0; // +20%, altrimenti il cacciatore non prende mai nessuno
const CATCH_DISTANCE = PLAYER_RADIUS * 2;
const ROUND_DURATION_MS = 45 * 1000;
const COUNTDOWN_MS = 3 * 1000;
const RESULT_PAUSE_MS = 5 * 1000;
const TICK_MS = 50; // 20 aggiornamenti al secondo

const OBSTACLES = [
  { x: 150, y: 120, w: 120, h: 40 },
  { x: 520, y: 400, w: 140, h: 40 },
  { x: 340, y: 250, w: 40, h: 140 },
];

// ---- Stato del gioco --------------------------------------------------
// players: Map<socketId, { id, name, x, y, input, role, alive, order }>
const players = new Map();
let joinCounter = 0;
let lastHunterOrder = -1; // per ruotare il cacciatore in modo equo tra i round

let phase = 'waiting'; // waiting | countdown | playing | ended
let phaseEndsAt = 0;
let roundEndsAt = 0;

function alivePlayers() {
  return [...players.values()].filter((p) => p.role !== 'spectator');
}

function connectedCount() {
  return players.size;
}

function pickNextHunter() {
  const candidates = [...players.values()].sort((a, b) => a.order - b.order);
  if (candidates.length === 0) return null;
  // scegli il primo giocatore connesso con "order" superiore all'ultimo cacciatore,
  // altrimenti riparti dall'inizio della lista (rotazione circolare)
  let next = candidates.find((p) => p.order > lastHunterOrder);
  if (!next) next = candidates[0];
  return next;
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

function startCountdown() {
  phase = 'countdown';
  phaseEndsAt = Date.now() + COUNTDOWN_MS;

  const hunter = pickNextHunter();
  for (const p of players.values()) {
    p.role = p.id === hunter?.id ? 'hunter' : 'runner';
    p.alive = true;
    const pos = spawnPosition();
    p.x = pos.x;
    p.y = pos.y;
    p.input = { up: false, down: false, left: false, right: false };
  }
  if (hunter) lastHunterOrder = hunter.order;
}

function startRound() {
  phase = 'playing';
  roundEndsAt = Date.now() + ROUND_DURATION_MS;
}

function endRound(winner) {
  phase = 'ended';
  phaseEndsAt = Date.now() + RESULT_PAUSE_MS;
  io.emit('roundResult', { winner });
}

function movePlayer(p, dt) {
  if (phase !== 'playing' || p.role === 'spectator' || !p.alive) return;

  const { up, down, left, right } = p.input;
  let dx = (right ? 1 : 0) - (left ? 1 : 0);
  let dy = (down ? 1 : 0) - (up ? 1 : 0);
  if (dx !== 0 && dy !== 0) {
    // normalizza il movimento in diagonale, altrimenti si andrebbe più
    // veloci in diagonale che in linea retta
    dx *= Math.SQRT1_2;
    dy *= Math.SQRT1_2;
  }

  const speed = p.role === 'hunter' ? HUNTER_SPEED : RUNNER_SPEED;
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
    checkCatches();
    if (phase === 'playing' && now >= roundEndsAt) endRound('runners');
  } else if (phase === 'ended') {
    if (now >= phaseEndsAt) {
      if (connectedCount() >= 2) startCountdown();
      else phase = 'waiting';
    }
  }

  io.emit('state', {
    phase,
    timeLeft: phase === 'playing' ? Math.max(0, roundEndsAt - now) : null,
    countdownLeft: phase === 'countdown' ? Math.max(0, phaseEndsAt - now) : null,
    arena: { w: ARENA_W, h: ARENA_H, obstacles: OBSTACLES },
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      role: p.role,
      alive: p.alive,
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
      input: { up: false, down: false, left: false, right: false },
      role: 'spectator', // entra come spettatore, gioca dal round successivo
      alive: true,
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
    };
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    if (connectedCount() < 2 && phase !== 'waiting') {
      phase = 'waiting';
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server pronto su http://localhost:${PORT}`);
});
