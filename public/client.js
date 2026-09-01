// client.js — login/registrazione, lobby (coda/inviti), e poi la partita
// vera e propria: disegna quello che il server manda e invia i tasti
// premuti. Il client NON decide chi vince o dove si trova nessuno: manda
// solo l'input, e disegna lo stato che riceve indietro. Tutta la logica di
// gioco vive in server.js/game.js.

// ---- Riferimenti agli elementi delle tre schermate -------------------------
const authScreen = document.getElementById('auth-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const forgotForm = document.getElementById('forgot-form');
const resetForm = document.getElementById('reset-form');
const authMessage = document.getElementById('auth-message');

const lobbyWelcome = document.getElementById('lobby-welcome');
const lobbyStats = document.getElementById('lobby-stats');
const lobbyIdle = document.getElementById('lobby-idle');
const lobbyQueued = document.getElementById('lobby-queued');
const lobbyInviteIncoming = document.getElementById('lobby-invite-incoming');
const lobbyInviteText = document.getElementById('lobby-invite-text');
const lobbyMessage = document.getElementById('lobby-message');
const findOpponentBtn = document.getElementById('find-opponent-btn');
const cancelQueueBtn = document.getElementById('cancel-queue-btn');
const inviteForm = document.getElementById('invite-form');
const inviteUsernameInput = document.getElementById('invite-username');
const acceptInviteBtn = document.getElementById('accept-invite-btn');
const declineInviteBtn = document.getElementById('decline-invite-btn');
const logoutBtn = document.getElementById('logout-btn');

const canvas = document.getElementById('arena');
const ctx = canvas.getContext('2d');
const matchScoreLabel = document.getElementById('match-score');
const banner = document.getElementById('banner');
const bigCountdown = document.getElementById('big-countdown');

function showScreen(name) {
  authScreen.hidden = name !== 'auth';
  lobbyScreen.hidden = name !== 'lobby';
  gameScreen.hidden = name !== 'game';
}

function showAuthForm(name) {
  loginForm.hidden = name !== 'login-form';
  registerForm.hidden = name !== 'register-form';
  forgotForm.hidden = name !== 'forgot-form';
  resetForm.hidden = name !== 'reset-form';
  authMessage.hidden = true;
}

function setMessage(el, text, isError) {
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('error', !!isError);
}

for (const link of document.querySelectorAll('[data-show]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showAuthForm(link.dataset.show);
  });
}

// ---- Chiamate all'API di autenticazione ------------------------------------
async function api(path, body) {
  const res = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

let currentUser = null;

function renderLobby() {
  if (!currentUser) return;
  lobbyWelcome.textContent = `Ciao, ${currentUser.username}!`;
  const s = currentUser.stats;
  const totalMatches = s.wins + s.losses;
  lobbyStats.textContent = totalMatches === 0
    ? 'Non hai ancora giocato nessuna partita.'
    : `${s.wins} vinte, ${s.losses} perse (${totalMatches} partit${totalMatches === 1 ? 'a' : 'e'}) — set: ${s.setsWon}-${s.setsLost}`;
}

function showLobbyIdle() {
  lobbyIdle.hidden = false;
  lobbyQueued.hidden = true;
  lobbyInviteIncoming.hidden = true;
}

async function refreshMe() {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!res.ok) return null;
  const { user } = await res.json();
  currentUser = user;
  renderLobby();
  return user;
}

// ---- Login / registrazione / reset password --------------------------------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockMediaOnce();
  const { ok, json } = await api('login', {
    emailOrUsername: document.getElementById('login-id').value.trim(),
    password: document.getElementById('login-password').value,
  });
  if (!ok) return setMessage(authMessage, json.error || 'Accesso non riuscito.', true);
  currentUser = json.user;
  connectSocket();
  renderLobby();
  showLobbyIdle();
  showScreen('lobby');
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { ok, json } = await api('register', {
    username: document.getElementById('register-username').value.trim(),
    email: document.getElementById('register-email').value.trim(),
    password: document.getElementById('register-password').value,
  });
  if (!ok) return setMessage(authMessage, json.error || 'Registrazione non riuscita.', true);
  registerForm.reset();
  showAuthForm('login-form');
  setMessage(authMessage, json.message, false);
});

forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { ok, json } = await api('request-password-reset', {
    email: document.getElementById('forgot-email').value.trim(),
  });
  forgotForm.reset();
  setMessage(authMessage, json.message || (ok ? 'Controlla la tua email.' : 'Qualcosa è andato storto.'), !ok);
});

let pendingResetToken = null;
resetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const { ok, json } = await api('reset-password', {
    token: pendingResetToken,
    newPassword: document.getElementById('reset-password').value,
  });
  if (!ok) return setMessage(authMessage, json.error || 'Reset non riuscito.', true);
  pendingResetToken = null;
  resetForm.reset();
  showAuthForm('login-form');
  setMessage(authMessage, json.message, false);
});

logoutBtn.addEventListener('click', async () => {
  if (socket) socket.close();
  socket = null;
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  currentUser = null;
  loginForm.reset();
  showAuthForm('login-form');
  showScreen('auth');
});

// ---- Avvio: login già fatto? link di verifica/reset nell'URL? -------------
async function init() {
  const params = new URLSearchParams(location.search);
  const verifyToken = params.get('verifyToken');
  const resetToken = params.get('resetToken');
  if (verifyToken || resetToken) {
    // toglie il token dalla barra degli indirizzi: non deve restarci
    // visibile/ricondivisibile una volta usato
    history.replaceState(null, '', location.pathname);
  }

  if (verifyToken) {
    const { ok, json } = await api('verify-email', { token: verifyToken });
    showAuthForm('login-form');
    setMessage(authMessage, json.message || json.error, !ok);
  } else if (resetToken) {
    pendingResetToken = resetToken;
    showAuthForm('reset-form');
  }

  const user = await refreshMe();
  if (user) {
    connectSocket();
    showLobbyIdle();
    showScreen('lobby');
  } else if (!verifyToken && !resetToken) {
    showAuthForm('login-form');
    showScreen('auth');
  } else {
    showScreen('auth');
  }
}
init();

// ---- Lobby: trova avversario / invita un amico -----------------------------
findOpponentBtn.addEventListener('click', () => {
  unlockMediaOnce();
  lobbyMessage.hidden = true;
  socket.emit('findOpponent');
});

cancelQueueBtn.addEventListener('click', () => {
  socket.emit('cancelFindOpponent');
});

inviteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = inviteUsernameInput.value.trim();
  if (!username) return;
  unlockMediaOnce();
  lobbyMessage.hidden = true;
  socket.emit('inviteFriend', { username });
});

let currentInviteId = null;
acceptInviteBtn.addEventListener('click', () => {
  unlockMediaOnce();
  socket.emit('respondInvite', { inviteId: currentInviteId, accept: true });
  showLobbyIdle();
});
declineInviteBtn.addEventListener('click', () => {
  socket.emit('respondInvite', { inviteId: currentInviteId, accept: false });
  showLobbyIdle();
});

// ---- Socket.io: solo dopo il login --------------------------------------
let socket = null;
let myId = null;
let latestState = null;

function connectSocket() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => { myId = socket.id; });

  socket.on('queued', () => {
    lobbyIdle.hidden = true;
    lobbyQueued.hidden = false;
    lobbyInviteIncoming.hidden = true;
  });
  socket.on('queueCancelled', () => showLobbyIdle());

  socket.on('inviteSent', ({ toUsername }) => {
    inviteForm.reset();
    setMessage(lobbyMessage, `Invito mandato a ${toUsername}, in attesa di risposta…`, false);
  });
  socket.on('inviteError', ({ message }) => {
    showLobbyIdle();
    setMessage(lobbyMessage, message, true);
  });
  socket.on('inviteReceived', ({ inviteId, fromUsername }) => {
    currentInviteId = inviteId;
    lobbyInviteText.textContent = `${fromUsername} ti ha invitato a giocare!`;
    lobbyIdle.hidden = true;
    lobbyQueued.hidden = true;
    lobbyInviteIncoming.hidden = false;
  });
  socket.on('inviteDeclined', ({ byUsername }) => {
    showLobbyIdle();
    setMessage(lobbyMessage, `${byUsername} ha rifiutato l'invito.`, true);
  });
  socket.on('inviteExpired', ({ fromUsername }) => {
    showLobbyIdle();
    setMessage(lobbyMessage, `L'invito di ${fromUsername} è scaduto.`, true);
  });

  socket.on('kicked', ({ message }) => {
    socket = null;
    currentUser = null;
    showAuthForm('login-form');
    setMessage(authMessage, message, true);
    showScreen('auth');
  });

  socket.on('matchStarting', () => {
    // reset dello stato "visivo" residuo di un'eventuale partita precedente,
    // altrimenti il primo frame della nuova partita potrebbe mostrare per
    // un istante posizioni/countdown vecchi
    lastRoleMessage = null;
    lastCountdownValue = null;
    walkState.clear();
    showScreen('game');
  });

  socket.on('matchEnded', async () => {
    await refreshMe();
    showLobbyIdle();
    showScreen('lobby');
  });
  socket.on('opponentLeft', async ({ name }) => {
    await refreshMe();
    showLobbyIdle();
    showScreen('lobby');
    setMessage(lobbyMessage, `${name} ha lasciato la partita.`, true);
  });

  socket.on('state', (state) => {
    latestState = state;
    updateHud(state);
  });

  socket.on('playerCaught', ({ name }) => {
    flashBanner(`${name} è stato preso!`, 1200);
  });

  socket.on('fruitEaten', ({ id }) => {
    if (id === myId) {
      flashBanner('🍎 +20% velocità per 5s!', 1400);
      playPickupTune();
    }
  });

  socket.on('roundResult', ({ winner, winnerId, score, matchOver, matchWinnerId, matchWinnerName }) => {
    const scoreText = score && score.length === 2
      ? `${score[0].name} ${score[0].sets}–${score[1].sets} ${score[1].name}`
      : null;

    let msg;
    if (matchOver) {
      msg = scoreText ? `🏆 ${matchWinnerName} vince la partita! (${scoreText})` : `🏆 ${matchWinnerName} vince la partita!`;
    } else {
      const setMsg = winner === 'hunter'
        ? 'Il cacciatore ha preso l\'avversario! 🎯'
        : 'È scappato/a per tutto il round! 🏃';
      msg = scoreText ? `${setMsg} (${scoreText})` : setMsg;
    }
    flashBanner(msg, matchOver ? 5500 : 4000);

    const amInMatch = !!(score && score.some((s) => s.id === myId));
    if (amInMatch) {
      if (matchOver) {
        if (matchWinnerId === myId) playMatchWinTune();
        else playSadTune();
      } else if (winnerId === myId) {
        playHappyTune();
      } else {
        playSadTune();
      }
    }
  });
}

// Il messaggio di ruolo ("Sei il cacciatore!", "Scappa!", ecc.) "lampeggia"
// (compare e si dissolve) invece di restare fisso — per farlo lampeggiare
// solo QUANDO cambia (e non a ogni singolo "tick" dello stato, ~20 volte al
// secondo) teniamo traccia dell'ultimo messaggio mostrato.
let lastRoleMessage = null;

function updateHud(state) {
  if (state.match) {
    const [a, b] = state.match.players;
    matchScoreLabel.textContent = `${a.name} ${a.sets}–${b.sets} ${b.name}`;
  } else {
    matchScoreLabel.textContent = '';
  }

  const me = state.players.find((p) => p.id === myId);
  let msg = null;
  if (state.phase === 'countdown') {
    msg = 'Si parte tra poco…';
  } else if (me) {
    if (me.role === 'hunter') msg = '🎯 Sei il cacciatore! Prendilo.';
    else if (me.alive) msg = '🏃 Scappa!';
    else msg = 'Sei stato preso — guarda il resto del set.';
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

// ---- Musichette di fine round/partita --------------------------------------
// Niente file audio da caricare: generiamo le note al volo con il Web
// Audio API, che ogni browser sa già fare da solo. I browser bloccano
// l'audio finché non c'è stata almeno un'interazione vera dell'utente —
// per questo "sblocchiamo" l'audio al primo gesto utile (login, trova
// avversario, invita, accetta invito: initAudio/tryKeepScreenAwake si
// guardano da sole dal fare doppio lavoro se richiamate più volte).
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
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

function playSadTune() {
  const notes = [392.0, 349.23, 311.13, 261.63];
  notes.forEach((freq, i) => playNote(freq, i * 0.22, 0.35));
}

function playHappyTune() {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((freq, i) => playNote(freq, i * 0.12, 0.25));
}

function playMatchWinTune() {
  const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.51];
  notes.forEach((freq, i) => playNote(freq, i * 0.11, 0.3, 0.16));
}

function playPickupTune() {
  playNote(880, 0, 0.08, 0.12);
  playNote(1174.66, 0.06, 0.12, 0.12);
}

// ---- Schermo sempre acceso (mobile) ---------------------------------------
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

function unlockMediaOnce() {
  initAudio();
  tryKeepScreenAwake();
}

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
const input = { up: false, down: false, left: false, right: false, vx: 0, vy: 0 };
const KEY_MAP = {
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
};

function setKey(e, value) {
  const dir = KEY_MAP[e.key];
  if (!dir || !socket) return;
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
const TRACKPOINT_THRESHOLD = 2;
const TRACKPOINT_RELEASE_MS = 120;
let trackpointTimeout = null;

canvas.addEventListener('click', () => {
  if (canvas.requestPointerLock) {
    canvas.requestPointerLock().catch(() => {});
  }
});

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) {
    input.up = input.down = input.left = input.right = false;
    input.vx = 0;
    input.vy = 0;
    if (socket) socket.emit('input', input);
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!socket) return;
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
    if (socket) socket.emit('input', input);
  }, TRACKPOINT_RELEASE_MS);
});

// ---- Joystick touch (telefono/tablet) -------------------------------------
const joystick = document.getElementById('joystick');
const joystickKnob = document.getElementById('joystick-knob');
const JOYSTICK_MAX_RADIUS = 40;
const JOYSTICK_DEADZONE = 12;

let joystickTouchId = null;
let joystickCenter = { x: 0, y: 0 };

function joystickReset() {
  joystickKnob.style.transform = 'translate(-50%, -50%)';
  input.up = input.down = input.left = input.right = false;
  input.vx = 0;
  input.vy = 0;
  if (socket) socket.emit('input', input);
}

function joystickHandleMove(touch) {
  if (!socket) return;
  const dx = touch.clientX - joystickCenter.x;
  const dy = touch.clientY - joystickCenter.y;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  const clampedDist = Math.min(dist, JOYSTICK_MAX_RADIUS);
  const knobX = Math.cos(angle) * clampedDist;
  const knobY = Math.sin(angle) * clampedDist;
  joystickKnob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;

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
};
const PLAYER_RADIUS = 14; // deve restare uguale a quello vero nel server, solo per il disegno

const walkState = new Map();

function darken(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((num >> 16) & 255) * (1 - amount));
  const g = Math.max(0, ((num >> 8) & 255) * (1 - amount));
  const b = Math.max(0, (num & 255) * (1 - amount));
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

function drawOmino(p) {
  const color = !p.alive ? COLORS.eliminated : COLORS[p.role] || '#888';
  const alpha = !p.alive ? 0.35 : 1;
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

  ctx.beginPath();
  ctx.ellipse(0, R * 0.75, R * 0.8, R * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fill();

  ctx.fillStyle = darken(color, 0.45);
  ctx.beginPath();
  ctx.ellipse(-R * 0.4, R * 0.85 + bob, R * 0.3, R * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(R * 0.4, R * 0.85 - bob, R * 0.3, R * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(-R * 0.35, -R * 0.4, R * 0.35, R * 0.22, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fill();

  ctx.fillStyle = '#0b0c10';
  ctx.beginPath();
  ctx.arc(-R * 0.32, -R * 0.05, R * 0.13, 0, Math.PI * 2);
  ctx.arc(R * 0.32, -R * 0.05, R * 0.13, 0, Math.PI * 2);
  ctx.fill();

  if (p.id === myId) {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, R + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (p.boosted) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 100);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(255, 200, 60, ${0.5 + 0.4 * pulse})`;
    ctx.beginPath();
    ctx.arc(0, 0, R + 6 + pulse * 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e8eaf0';
  ctx.font = '10px "Press Start 2P", system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, p.x, p.y - R - 10);
}

function drawFruit(f) {
  const pulse = 1 + 0.08 * Math.sin(Date.now() / 250 + f.id);
  const r = 9 * pulse;

  ctx.save();
  ctx.translate(f.x, f.y);

  ctx.fillStyle = '#4caf50';
  ctx.beginPath();
  ctx.ellipse(3, -r * 1.1, 4, 2.2, -0.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb648';
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(-r * 0.3, -r * 0.3, r * 0.3, r * 0.18, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fill();

  ctx.restore();
}

function draw() {
  requestAnimationFrame(draw);
  if (gameScreen.hidden || !latestState) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#33384a';
  for (const o of latestState.arena.obstacles) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }

  for (const f of latestState.fruits || []) {
    drawFruit(f);
  }

  const currentIds = new Set(latestState.players.map((p) => p.id));
  for (const id of walkState.keys()) {
    if (!currentIds.has(id)) walkState.delete(id);
  }

  for (const p of latestState.players) {
    drawOmino(p);
  }
}
requestAnimationFrame(draw);
