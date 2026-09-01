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

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  socket.emit('join', nameInput.value.trim() || 'Omino');
  joinScreen.hidden = true;
  gameScreen.hidden = false;
  // Il click sul bottone "Entra in partita" è un gesto dell'utente: è
  // l'unico momento in cui il browser ci permette di chiedere fullscreen /
  // blocco orientamento / schermo sempre acceso. Se lo facessimo dopo,
  // senza un click appena avvenuto, il browser rifiuterebbe la richiesta.
  await tryLockLandscape();
  await tryKeepScreenAwake();
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

// ---- Orientamento orizzontale e schermo sempre acceso (mobile) -----------
// Bloccare davvero l'orientamento è "best effort": funziona su Chrome
// Android (e di solito richiede prima il fullscreen), ma su Safari/iPhone
// questa API web non esiste affatto — per questo teniamo comunque
// l'avviso "ruota il telefono" (in index.html/style.css) come soluzione
// che funziona sempre, ovunque questo tentativo fallisca in silenzio.
async function tryLockLandscape() {
  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!isTouch) return;
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (err) {
    // niente di grave: restiamo con l'avviso di ruotare il telefono a mano
  }
}

// Il telefono spegnerebbe lo schermo per inattività, ma durante la partita
// non stai "toccando" lo schermo in continuazione (tieni il dito fermo sul
// joystick) — il Wake Lock dice al sistema operativo di non spegnerlo.
let wakeLock = null;
async function tryKeepScreenAwake() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    // non grave: nel peggiore dei casi lo schermo si spegne dopo un po'
  }
}

// Il Wake Lock si rilascia da solo quando cambi scheda/app; se torni sul
// gioco proviamo a richiederlo di nuovo.
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible' && !gameScreen.hidden) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      // ignorabile
    }
  }
});

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

// Proviamo ad "agganciare" il cursore (Pointer Lock): così il movimento
// resta relativo e infinito, senza fermarsi quando il cursore tocca il
// bordo dello schermo. Se il browser lo rifiuta (es. per il vincolo di
// contesto sicuro su indirizzi non-HTTPS) non succede nulla di grave: il
// movimento via mousemove qui sotto continua a funzionare come prima,
// solo con il limite del bordo schermo.
canvas.addEventListener('click', () => {
  if (canvas.requestPointerLock) {
    canvas.requestPointerLock().catch(() => {
      // niente da fare: restiamo nella modalità "cursore libero"
    });
  }
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) {
    // l'aggancio è stato rilasciato (es. hai premuto Esc): fermiamo il movimento
    input.up = input.down = input.left = input.right = false;
    socket.emit('input', input);
  }
});

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

// ---- Joystick touch (telefono/tablet) -------------------------------------
// A differenza del TrackPoint, il touch ha un evento "l'ho rilasciato" vero
// (touchend), quindi qui non serve nessun timeout per simulare il rilascio.
const joystick = document.getElementById('joystick');
const joystickKnob = document.getElementById('joystick-knob');
const JOYSTICK_MAX_RADIUS = 40; // quanto può spostarsi visivamente la manopola
const JOYSTICK_DEADZONE = 12;   // spostamento minimo prima di contare come "spinto"

let joystickTouchId = null;
let joystickCenter = { x: 0, y: 0 };

function joystickReset() {
  joystickKnob.style.transform = 'translate(-50%, -50%)';
  input.up = input.down = input.left = input.right = false;
  socket.emit('input', input);
}

function joystickHandleMove(touch) {
  const dx = touch.clientX - joystickCenter.x;
  const dy = touch.clientY - joystickCenter.y;
  const dist = Math.hypot(dx, dy);

  // muovi la manopola visivamente, senza uscire dal cerchio
  const clampedDist = Math.min(dist, JOYSTICK_MAX_RADIUS);
  const angle = Math.atan2(dy, dx);
  const knobX = Math.cos(angle) * clampedDist;
  const knobY = Math.sin(angle) * clampedDist;
  joystickKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;

  const dir = dist < JOYSTICK_DEADZONE
    ? { up: false, down: false, left: false, right: false }
    : {
        up: dy < -JOYSTICK_DEADZONE,
        down: dy > JOYSTICK_DEADZONE,
        left: dx < -JOYSTICK_DEADZONE,
        right: dx > JOYSTICK_DEADZONE,
      };

  let changed = false;
  for (const d of ['up', 'down', 'left', 'right']) {
    if (input[d] !== dir[d]) { input[d] = dir[d]; changed = true; }
  }
  if (changed) socket.emit('input', input);
}

joystick.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.changedTouches[0];
  joystickTouchId = touch.identifier;
  const rect = joystick.getBoundingClientRect();
  joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  joystickHandleMove(touch);
});

joystick.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    if (touch.identifier === joystickTouchId) joystickHandleMove(touch);
  }
});

function joystickHandleEnd(e) {
  for (const touch of e.changedTouches) {
    if (touch.identifier === joystickTouchId) {
      joystickTouchId = null;
      joystickReset();
    }
  }
}
joystick.addEventListener('touchend', joystickHandleEnd);
joystick.addEventListener('touchcancel', joystickHandleEnd);

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
