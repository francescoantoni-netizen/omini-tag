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
const playersLabel = document.getElementById('players-label');
const banner = document.getElementById('banner');
const bigCountdown = document.getElementById('big-countdown');

let myId = null;
let latestState = null;

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  socket.emit('join', nameInput.value.trim() || 'Omino');
  joinScreen.hidden = true;
  gameScreen.hidden = false;
  // Il click sul bottone "Entra in partita" è un gesto dell'utente: è
  // l'unico momento in cui il browser ci permette di chiedere lo schermo
  // sempre acceso, ed è anche l'unico momento in cui può partire l'audio.
  await tryKeepScreenAwake();
  initAudio();
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

socket.on('fruitEaten', ({ id }) => {
  // il "lampeggio"/suono di raccolta è personale: senza questo controllo,
  // ogni giocatore sentirebbe/vedrebbe il feedback anche quando il frutto
  // lo mangia qualcun altro, diventando fastidioso in fretta
  if (id === myId) {
    flashBanner('🍎 +20% velocità per 5s!', 1400);
    playPickupTune();
  }
});

socket.on('roundResult', ({ winner }) => {
  const msg = winner === 'hunter'
    ? 'Il cacciatore ha preso tutti! 🎯'
    : 'I fuggitivi ce l\'hanno fatta! 🏆';
  flashBanner(msg, 4000);
  if (winner === 'hunter') playSadTune();
  else playHappyTune();
});

// Il messaggio di ruolo/fase ("Si parte tra poco…", "Sei stato preso",
// ecc.) non è più una scritta fissa nell'HUD: come chiesto, ora "lampeggia"
// (compare e si dissolve) come il banner di fine round, invece di restare
// sempre visibile. Per farlo lampeggiare solo QUANDO cambia (e non a ogni
// singolo "tick" dello stato, che arriva ~20 volte al secondo) teniamo
// traccia dell'ultimo messaggio mostrato.
let lastRoleMessage = null;

function updateHud(state) {
  playersLabel.textContent = `${state.players.length} giocatori`;

  const me = state.players.find((p) => p.id === myId);
  let msg = null;
  if (state.phase === 'waiting') {
    msg = 'In attesa di altri giocatori…';
  } else if (state.phase === 'countdown') {
    msg = 'Si parte tra poco…';
  } else if (me) {
    if (me.role === 'hunter') msg = '🎯 Sei il cacciatore! Prendili tutti.';
    else if (me.role === 'runner' && me.alive) msg = '🏃 Scappa!';
    else if (me.role === 'runner' && !me.alive) msg = 'Sei stato preso — guarda il resto del round.';
    else msg = 'Spettatore, giochi dal prossimo round.';
  }
  if (msg && msg !== lastRoleMessage) {
    lastRoleMessage = msg;
    flashBanner(msg, 2200);
  }

  updateBigCountdown(state);
}

// Conto alla rovescia grosso: mostra i secondi del "3…2…1…" prima del via
// e poi i secondi rimasti nel round, con un piccolo "pop" ad ogni cambio
// numero per dare energia da sala giochi. Nessuna scritta fissa: appare
// solo quando c'è davvero un conto alla rovescia in corso.
let lastCountdownValue = null;
function updateBigCountdown(state) {
  let seconds = null;
  if (state.phase === 'countdown' && state.countdownLeft != null) {
    seconds = Math.ceil(state.countdownLeft / 1000);
  } else if (state.phase === 'playing' && state.timeLeft != null) {
    seconds = Math.ceil(state.timeLeft / 1000);
  }

  if (seconds === null) {
    bigCountdown.classList.remove('show');
    lastCountdownValue = null;
    return;
  }

  bigCountdown.classList.add('show');
  if (seconds !== lastCountdownValue) {
    lastCountdownValue = seconds;
    bigCountdown.textContent = state.phase === 'countdown' && seconds <= 0 ? 'VIA!' : String(seconds);
    // ritogliere e rimettere la classe forza il browser a "ripartire" con
    // l'animazione da capo invece di ignorarla perché è già attiva
    bigCountdown.classList.remove('pulse');
    void bigCountdown.offsetWidth;
    bigCountdown.classList.add('pulse');
  }
}

let bannerTimeout = null;
function flashBanner(text, ms) {
  banner.textContent = text;
  banner.classList.add('show');
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => { banner.classList.remove('show'); }, ms);
}

// ---- Musichette di fine round ---------------------------------------------
// Niente file audio da caricare: generiamo le note al volo con il Web
// Audio API, che ogni browser sa già fare da solo. I browser bloccano
// l'audio finché non c'è stata almeno un'interazione vera dell'utente —
// per questo "sblocchiamo" l'audio proprio nel click di "Entra in
// partita" (initAudio, chiamato più sotto), lo stesso identico gesto che
// usiamo già per lo schermo sempre acceso.
let audioCtx = null;
function initAudio() {
  if (audioCtx) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    audioCtx = new AudioContextClass();
  } catch (err) {
    // non grave: nel peggiore dei casi il gioco resta senza suoni
  }
}

function playNote(freq, startDelay, duration, volume = 0.15) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  const startTime = audioCtx.currentTime + startDelay;
  // una piccola "busta" di volume che sale e scende dolcemente: senza,
  // si sente un click secco all'inizio e alla fine di ogni nota
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

function playSadTune() {
  // 4 note discendenti in tonalità minore: la classica "musichina della
  // sconfitta" (Sol-Fa-Mib-Do)
  const notes = [392.0, 349.23, 311.13, 261.63];
  notes.forEach((freq, i) => playNote(freq, i * 0.22, 0.35));
}

function playHappyTune() {
  // piccolo arpeggio ascendente in maggiore: una mini-fanfara di vittoria
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => playNote(freq, i * 0.12, 0.25));
}

function playPickupTune() {
  // due note brevi e acute: il classico "blip" di raccolta oggetto
  playNote(880, 0, 0.08, 0.12);
  playNote(1174.66, 0.06, 0.12, 0.12);
}

// ---- Schermo sempre acceso (mobile) ---------------------------------------
// Non proviamo più a forzare l'orientamento orizzontale via JS (fullscreen +
// screen.orientation.lock): su alcuni telefoni/browser mandava in confusione
// il ridimensionamento della pagina. Restiamo con la soluzione più semplice
// e affidabile ovunque: il CSS adatta l'arena allo schermo disponibile, e se
// il telefono è in verticale mostriamo l'avviso di ruotarlo a mano.

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
// vx/vy sono usati solo dal joystick touch (direzione analogica a 360°);
// tastiera e TrackPoint restano a interruttori (up/down/left/right) come
// sempre e si assicurano di azzerare vx/vy ogni volta, così se cambi
// metodo di controllo a metà partita non resta "incastrato" un vecchio
// valore del joystick.
const input = { up: false, down: false, left: false, right: false, vx: 0, vy: 0 };
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
    input.vx = 0;
    input.vy = 0;
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
    input.vx = 0;
    input.vy = 0;
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
  if (changed) {
    input.vx = 0;
    input.vy = 0;
    socket.emit('input', input);
  }

  clearTimeout(trackpointTimeout);
  trackpointTimeout = setTimeout(() => {
    input.up = input.down = input.left = input.right = false;
    input.vx = 0;
    input.vy = 0;
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
  input.vx = 0;
  input.vy = 0;
  socket.emit('input', input);
}

function joystickHandleMove(touch) {
  const dx = touch.clientX - joystickCenter.x;
  const dy = touch.clientY - joystickCenter.y;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  // muovi la manopola visivamente, senza uscire dal cerchio
  const clampedDist = Math.min(dist, JOYSTICK_MAX_RADIUS);
  const knobX = Math.cos(angle) * clampedDist;
  const knobY = Math.sin(angle) * clampedDist;
  joystickKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;

  // Direzione a 360°, non più arrotondata alle 8 direzioni di
  // tastiera/TrackPoint: quanto sei fuori dalla zona morta diventa
  // un'intensità graduale da 0 a 1 (spingi appena = cammini piano, spingi
  // fino al bordo = velocità massima), nell'identico angolo verso cui hai
  // spinto il dito.
  let vx = 0;
  let vy = 0;
  if (dist > JOYSTICK_DEADZONE) {
    const magnitude = Math.min(
      (dist - JOYSTICK_DEADZONE) / (JOYSTICK_MAX_RADIUS - JOYSTICK_DEADZONE),
      1
    );
    vx = Math.cos(angle) * magnitude;
    vy = Math.sin(angle) * magnitude;
  }

  if (input.vx !== vx || input.vy !== vy) {
    input.vx = vx;
    input.vy = vy;
    input.up = input.down = input.left = input.right = false;
    socket.emit('input', input);
  }
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
const PLAYER_RADIUS = 14; // deve restare uguale a quello vero nel server, solo per il disegno

// Per far "camminare" i piedini (si muovono avanti/indietro solo mentre ti
// sposti davvero) teniamo per ogni giocatore l'ultima posizione vista e una
// fase di animazione che avanza in base a quanta strada ha fatto.
const walkState = new Map();

// Scurisce un colore esadecimale (#rrggbb) di una quantità 0-1, per i
// piedini/ombre — evita di dover scrivere a mano una tinta scura per ogni
// colore del gioco.
function darken(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((num >> 16) & 255) * (1 - amount));
  const g = Math.max(0, ((num >> 8) & 255) * (1 - amount));
  const b = Math.max(0, (num & 255) * (1 - amount));
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

// Un "omino" visto dall'alto, in stile chibi/giochino: corpo rotondo,
// piedini che spuntano da sotto e si muovono camminando, un riflesso
// lucido e due occhietti — non più un semplice pallino piatto.
function drawOmino(p) {
  const color = !p.alive ? COLORS.eliminated : COLORS[p.role] || '#888';
  const alpha = p.role === 'spectator' || !p.alive ? 0.35 : 1;
  const R = PLAYER_RADIUS;

  let ws = walkState.get(p.id);
  if (!ws) {
    ws = { lastX: p.x, lastY: p.y, phase: 0 };
    walkState.set(p.id, ws);
  }
  const moved = Math.hypot(p.x - ws.lastX, p.y - ws.lastY);
  if (moved > 0.3) ws.phase += 0.35;
  ws.lastX = p.x;
  ws.lastY = p.y;
  const bob = Math.sin(ws.phase) * 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.x, p.y);

  // ombra sotto, per dare un po' di "spessore" visto dall'alto
  ctx.beginPath();
  ctx.ellipse(0, R * 0.75, R * 0.8, R * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fill();

  // piedini: due ovali scuri che spuntano da sotto al corpo e si alternano
  // leggermente mentre cammina (li teniamo vicino al bordo esatto del
  // corpo, altrimenti il cerchio disegnato sopra li coprirebbe quasi del
  // tutto)
  ctx.fillStyle = darken(color, 0.45);
  ctx.beginPath();
  ctx.ellipse(-R * 0.4, R * 0.85 + bob, R * 0.3, R * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(R * 0.4, R * 0.85 - bob, R * 0.3, R * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();

  // corpo/testa: un unico cerchio morbido stile chibi
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // riflesso lucido in alto a sinistra, per un effetto "plastica da giochino"
  ctx.beginPath();
  ctx.ellipse(-R * 0.35, -R * 0.4, R * 0.35, R * 0.22, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fill();

  // occhietti
  ctx.fillStyle = '#0b0c10';
  ctx.beginPath();
  ctx.arc(-R * 0.32, -R * 0.05, R * 0.13, 0, Math.PI * 2);
  ctx.arc(R * 0.32, -R * 0.05, R * 0.13, 0, Math.PI * 2);
  ctx.fill();

  // contorno bianco: "questo sei tu"
  if (p.id === myId) {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, R + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // anello dorato pulsante: "ho mangiato un frutto, sono più veloce" — si
  // vede anche sugli altri giocatori, non solo su di te, così tutti
  // capiscono al volo chi ha il boost attivo in questo momento
  if (p.boosted) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 100);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(255, 200, 60, ${0.5 + 0.4 * pulse})`;
    ctx.beginPath();
    ctx.arc(0, 0, R + 6 + pulse * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  // nome sopra la testa
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e8eaf0';
  ctx.font = '10px "Press Start 2P", system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, p.x, p.y - R - 10);
}

// Frutto col boost: corpo arancio/dorato (colore diverso apposta dal rosso
// del cacciatore, per non confonderli a colpo d'occhio), con un piccolo
// "respiro" (si ingrandisce e rimpicciolisce leggermente) che lo fa notare
// come oggetto raccoglibile invece che un elemento fisso della mappa.
function drawFruit(f) {
  const pulse = 1 + 0.08 * Math.sin(Date.now() / 250 + f.id);
  const r = 9 * pulse;

  ctx.save();
  ctx.translate(f.x, f.y);

  // fogliolina
  ctx.fillStyle = '#4caf50';
  ctx.beginPath();
  ctx.ellipse(3, -r * 1.1, 4, 2.2, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // corpo del frutto
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb648';
  ctx.fill();

  // riflesso
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, -r * 0.3, r * 0.3, r * 0.18, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fill();

  ctx.restore();
}

function draw() {
  requestAnimationFrame(draw);
  if (!latestState) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // ostacoli
  ctx.fillStyle = '#33384a';
  for (const o of latestState.arena.obstacles) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }

  // frutti: disegnati PRIMA dei giocatori, così chi ci cammina sopra
  // sembra passarci davanti invece che sopra
  for (const f of latestState.fruits || []) {
    drawFruit(f);
  }

  // dimentica gli omini di chi si è disconnesso, altrimenti la mappa
  // walkState crescerebbe all'infinito partita dopo partita
  const currentIds = new Set(latestState.players.map((p) => p.id));
  for (const id of walkState.keys()) {
    if (!currentIds.has(id)) walkState.delete(id);
  }

  // giocatori
  for (const p of latestState.players) {
    drawOmino(p);
  }
}
requestAnimationFrame(draw);
