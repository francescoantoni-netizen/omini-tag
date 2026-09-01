// client.js — disegna quello che il server manda e invia i tasti premuti.
// Il client NON decide chi vince o dove si trova nessuno: manda solo
// l'input, e disegna lo stato che riceve indietro. Tutta la logica di
// gioco vive in server.js.

const socket = io();

const joinScreen = document.getElementById('join-screen');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const gameScreen = document.getElementById('game-screen');
const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');
const roleLabel = document.getElementById('role-label');
const timerLabel = document.getElementById('timer-label');
const playersLabel = document.getElementById('players-label');
const banner = document.getElementById('banner');

let myId = null;
let latestState = null;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('join', nameInput.value.trim() || 'Omino');
  joinScreen.hidden = true;
  gameScreen.hidden = false;
});

socket.on('joined', ({ id }) => {
  myId = id;
});

socket.on('state', (state) => {
  latestState = state;
  updateHud(state);
});

socket.on('playerCaught', ({ name }) => {
  flashBanner(`${name} è stato preso!`, 1200);
});

socket.on('roundResult', ({ winner }) => {
  const msg = winner === 'hunter'
    ? 'Il cacciatore ha preso tutti! 🎯'
    : 'I fuggitivi ce l\'hanno fatta! 🏆';
  flashBanner(msg, 4000);
});

function updateHud(state) {
  playersLabel.textContent = `${state.players.length} giocatori`;

  const me = state.players.find((p) => p.id === myId);
  if (state.phase === 'waiting') {
    roleLabel.textContent = 'In attesa di altri giocatori…';
  } else if (state.phase === 'countdown') {
    roleLabel.textContent = 'Si parte tra poco…';
  } else if (me) {
    if (me.role === 'hunter') roleLabel.textContent = '🎯 Sei il cacciatore! Prendili tutti.';
    else if (me.role === 'runner' && me.alive) roleLabel.textContent = '🏃 Scappa!';
    else if (me.role === 'runner' && !me.alive) roleLabel.textContent = 'Sei stato preso — guarda il resto del round.';
    else roleLabel.textContent = 'Spettatore, giochi dal prossimo round.';
  }

  timerLabel.textContent = state.phase === 'playing' && state.timeLeft != null
    ? `⏱ ${Math.ceil(state.timeLeft / 1000)}s`
    : '';
}

let bannerTimeout = null;
function flashBanner(text, ms) {
  banner.textContent = text;
  banner.hidden = false;
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => { banner.hidden = true; }, ms);
}

// ---- Input da tastiera ----------------------------------------------------
const input = { up: false, down: false, left: false, right: false };
const KEY_MAP = {
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
};

function setKey(e, value) {
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  if (input[dir] !== value) {
    input[dir] = value;
    socket.emit('input', input);
  }
}
window.addEventListener('keydown', (e) => setKey(e, true));
window.addEventListener('keyup', (e) => setKey(e, false));

// ---- Controllo con il TrackPoint (il tappo rosso dei portatili Lenovo) ---
// Il TrackPoint si comporta come un mouse: quando lo spingi, il browser
// riceve eventi "mousemove" con lo spostamento relativo da un istante
// all'altro (event.movementX / movementY). A differenza dei tasti non
// esiste un evento "l'ho rilasciato" — quindi consideriamo il movimento
// "fermo" se non arriva nessun nuovo evento per un breve istante.
const TRACKPOINT_THRESHOLD = 2;   // sensibilità minima per contare come "spinto"
const TRACKPOINT_RELEASE_MS = 120; // se non arrivano eventi per questo tempo, fermati
let trackpointTimeout = null;

canvas.addEventListener('mousemove', (e) => {
  const dx = e.movementX || 0;
  const dy = e.movementY || 0;
  if (dx === 0 && dy === 0) return;

  const dir = {
    up: dy < -TRACKPOINT_THRESHOLD,
    down: dy > TRACKPOINT_THRESHOLD,
    left: dx < -TRACKPOINT_THRESHOLD,
    right: dx > TRACKPOINT_THRESHOLD,
  };
  let changed = false;
  for (const d of ['up', 'down', 'left', 'right']) {
    if (input[d] !== dir[d]) { input[d] = dir[d]; changed = true; }
  }
  if (changed) socket.emit('input', input);

  clearTimeout(trackpointTimeout);
  trackpointTimeout = setTimeout(() => {
    input.up = input.down = input.left = input.right = false;
    socket.emit('input', input);
  }, TRACKPOINT_RELEASE_MS);
});

// ---- Rendering --------------------------------------------------------
const COLORS = {
  hunter: '#f6564c',
  runner: '#4f9dfd',
  eliminated: '#5a5f6c',
  spectator: '#5a5f6c',
};

function draw() {
  requestAnimationFrame(draw);
  if (!latestState) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ostacoli
  ctx.fillStyle = '#33384a';
  for (const o of latestState.arena.obstacles) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }

  // giocatori
  for (const p of latestState.players) {
    const color = !p.alive ? COLORS.eliminated : COLORS[p.role] || '#888';
    ctx.globalAlpha = p.role === 'spectator' || !p.alive ? 0.35 : 1;

    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (p.id === myId) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e8eaf0';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y - 22);
  }
}
requestAnimationFrame(draw);
