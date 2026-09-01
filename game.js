// game.js — la partita 1v1 vera e propria (arena, round/set, cattura,
// frutti). Prima viveva come stato globale unico dentro server.js: ora è
// una classe Room, così il server può tenerne in vita tante insieme,
// una per ogni coppia di giocatori che sta giocando in questo momento —
// esattamente come un sito di scacchi gestisce tante partite in
// contemporanea, non solo una alla volta.

const { pool } = require('./db');

// ---- Costanti di design (vedi DESIGN.md) ----------------------------------
const ARENA_W = 800;
const ARENA_H = 600;
const PLAYER_RADIUS = 14;
const RUNNER_SPEED = 200; // px al secondo
const HUNTER_SPEED = RUNNER_SPEED * 1.0;
const CATCH_DISTANCE = PLAYER_RADIUS * 2;
const ROUND_DURATION_MS = 45 * 1000;
const COUNTDOWN_MS = 3 * 1000;
const RESULT_PAUSE_MS = 5 * 1000;
const MATCH_RESULT_PAUSE_MS = 7 * 1000;
const TICK_MS = 50; // 20 aggiornamenti al secondo

const FRUIT_RADIUS = 10;
const FRUIT_COUNT = 3;
const FRUIT_BOOST_MULTIPLIER = 1.2;
const FRUIT_BOOST_DURATION_MS = 5 * 1000;
const FRUIT_RESPAWN_DELAY_MS = 4 * 1000;

const SETS_TO_WIN = 3;

const OBSTACLES = [
  { x: 150, y: 120, w: 120, h: 40 },
  { x: 520, y: 400, w: 140, h: 40 },
  { x: 340, y: 250, w: 40, h: 140 },
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

function spawnPosition() {
  for (let tries = 0; tries < 20; tries++) {
    const x = PLAYER_RADIUS + Math.random() * (ARENA_W - PLAYER_RADIUS * 2);
    const y = PLAYER_RADIUS + Math.random() * (ARENA_H - PLAYER_RADIUS * 2);
    if (!collidesWithObstacles(x, y)) return { x, y };
  }
  return { x: ARENA_W / 2, y: ARENA_H / 2 };
}

let fruitIdCounter = 0;
function spawnFruitPosition() {
  for (let tries = 0; tries < 20; tries++) {
    const x = FRUIT_RADIUS + Math.random() * (ARENA_W - FRUIT_RADIUS * 2);
    const y = FRUIT_RADIUS + Math.random() * (ARENA_H - FRUIT_RADIUS * 2);
    if (!collidesWithObstacles(x, y)) return { id: fruitIdCounter++, x, y };
  }
  return { id: fruitIdCounter++, x: ARENA_W / 2, y: ARENA_H / 2 };
}

let roomIdCounter = 0;

// Una Room = una partita 1 contro 1 in corso, dal primo "3…2…1…" fino a
// quando uno dei due arriva a 3 set vinti (o uno dei due si disconnette).
// Ogni Room ha il proprio timer/interval indipendente dalle altre.
class Room {
  /**
   * @param {import('socket.io').Server} io
   * @param {{socket, userId, username}} entryA
   * @param {{socket, userId, username}} entryB
   * @param {'queue'|'invite'} startedVia
   * @param {(room: Room) => void} onEnded chiamata quando la Room finisce
   *   (partita completata o abbandonata) e va rimossa dal server
   */
  constructor(io, entryA, entryB, startedVia, onEnded) {
    this.id = `room-${++roomIdCounter}`;
    this.io = io;
    this.channel = this.id; // nome della "room" di Socket.io usata per gli emit mirati
    this.startedVia = startedVia;
    this.onEnded = onEnded;
    this.ended = false;

    this.players = new Map(); // socket.id -> stato del giocatore
    for (const entry of [entryA, entryB]) {
      entry.socket.join(this.channel);
      entry.socket.data.roomId = this.id;
      this.players.set(entry.socket.id, {
        socketId: entry.socket.id,
        userId: entry.userId,
        username: entry.username,
        x: 0,
        y: 0,
        role: 'runner',
        alive: true,
        boostUntil: 0,
        input: { up: false, down: false, left: false, right: false, vx: 0, vy: 0 },
      });
    }
    this.playerOrder = [...this.players.keys()]; // stabile per tutta la Room

    this.setScore = {};
    for (const id of this.playerOrder) this.setScore[id] = 0;
    this.lastHunterId = null;

    this.phase = 'countdown';
    this.phaseEndsAt = Date.now() + COUNTDOWN_MS;
    this.roundEndsAt = 0;
    this.fruits = [];
    this.pendingFruitRespawns = [];

    this._assignRolesForNewSet();
    this._resetFruits();

    this.lastTick = Date.now();
    this.interval = setInterval(() => this._tick(), TICK_MS);
  }

  opponentOf(socketId) {
    const otherId = this.playerOrder.find((id) => id !== socketId);
    return this.players.get(otherId);
  }

  handleInput(socketId, input) {
    const p = this.players.get(socketId);
    if (!p || !input) return;
    p.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
      vx: typeof input.vx === 'number' ? clamp(input.vx, -1, 1) : 0,
      vy: typeof input.vy === 'number' ? clamp(input.vy, -1, 1) : 0,
    };
  }

  // Un giocatore si è disconnesso mentre la Room era ancora viva: la
  // partita si interrompe qui, niente punteggio registrato (non è un vero
  // set/partita "giocata e persa", è un abbandono).
  handleDisconnect(socketId) {
    const leaving = this.players.get(socketId);
    const opponent = this.opponentOf(socketId);
    if (opponent) {
      this.io.to(opponent.socketId).emit('opponentLeft', {
        name: leaving ? leaving.username : 'Il tuo avversario',
      });
    }
    this._end();
  }

  _assignRolesForNewSet() {
    let hunterId;
    if (this.lastHunterId != null && this.players.has(this.lastHunterId)) {
      hunterId = this.playerOrder.find((id) => id !== this.lastHunterId);
    } else {
      hunterId = this.playerOrder[Math.floor(Math.random() * this.playerOrder.length)];
    }
    this.lastHunterId = hunterId;

    for (const [id, p] of this.players) {
      p.role = id === hunterId ? 'hunter' : 'runner';
      p.alive = true;
      const pos = spawnPosition();
      p.x = pos.x;
      p.y = pos.y;
      p.input = { up: false, down: false, left: false, right: false, vx: 0, vy: 0 };
      p.boostUntil = 0;
    }
  }

  _resetFruits() {
    this.fruits = [];
    this.pendingFruitRespawns = [];
    for (let i = 0; i < FRUIT_COUNT; i++) this.fruits.push(spawnFruitPosition());
  }

  _startRound() {
    this.phase = 'playing';
    this.roundEndsAt = Date.now() + ROUND_DURATION_MS;
  }

  _movePlayer(p, dt) {
    if (this.phase !== 'playing' || !p.alive) return;

    let dx, dy;
    if (p.input.vx !== 0 || p.input.vy !== 0) {
      dx = p.input.vx;
      dy = p.input.vy;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) { dx /= mag; dy /= mag; }
    } else {
      const { up, down, left, right } = p.input;
      dx = (right ? 1 : 0) - (left ? 1 : 0);
      dy = (down ? 1 : 0) - (up ? 1 : 0);
      if (dx !== 0 && dy !== 0) {
        dx *= Math.SQRT1_2;
        dy *= Math.SQRT1_2;
      }
    }

    const baseSpeed = p.role === 'hunter' ? HUNTER_SPEED : RUNNER_SPEED;
    const boosted = p.boostUntil && Date.now() < p.boostUntil;
    const speed = boosted ? baseSpeed * FRUIT_BOOST_MULTIPLIER : baseSpeed;
    const step = (speed * dt) / 1000;

    const newX = clamp(p.x + dx * step, PLAYER_RADIUS, ARENA_W - PLAYER_RADIUS);
    if (!collidesWithObstacles(newX, p.y)) p.x = newX;

    const newY = clamp(p.y + dy * step, PLAYER_RADIUS, ARENA_H - PLAYER_RADIUS);
    if (!collidesWithObstacles(p.x, newY)) p.y = newY;
  }

  _checkFruitPickups() {
    if (this.phase !== 'playing') return;
    const now = Date.now();
    const pickupRadius = PLAYER_RADIUS + FRUIT_RADIUS;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (let i = this.fruits.length - 1; i >= 0; i--) {
        const f = this.fruits[i];
        const dx = p.x - f.x;
        const dy = p.y - f.y;
        if (dx * dx + dy * dy < pickupRadius * pickupRadius) {
          this.fruits.splice(i, 1);
          p.boostUntil = now + FRUIT_BOOST_DURATION_MS;
          this.pendingFruitRespawns.push(now + FRUIT_RESPAWN_DELAY_MS);
          this.io.to(this.channel).emit('fruitEaten', { id: p.socketId, name: p.username });
        }
      }
    }
  }

  _checkCatches() {
    if (this.phase !== 'playing') return;
    const hunter = [...this.players.values()].find((p) => p.role === 'hunter');
    const runner = [...this.players.values()].find((p) => p.role === 'runner');
    if (!hunter || !runner || !runner.alive) return;

    const dx = runner.x - hunter.x;
    const dy = runner.y - hunter.y;
    if (dx * dx + dy * dy < CATCH_DISTANCE * CATCH_DISTANCE) {
      runner.alive = false;
      this.io.to(this.channel).emit('playerCaught', { id: runner.socketId, name: runner.username });
      this._endSet('hunter');
    }
  }

  _endSet(winner) {
    this.phase = 'ended';
    this.fruits = [];
    this.pendingFruitRespawns = [];

    const hunterId = this.playerOrder.find((id) => this.players.get(id).role === 'hunter');
    const runnerId = this.playerOrder.find((id) => id !== hunterId);
    const setWinnerId = winner === 'hunter' ? hunterId : runnerId;
    this.setScore[setWinnerId] += 1;

    const matchWinnerId = this.playerOrder.find((id) => this.setScore[id] >= SETS_TO_WIN) || null;
    const matchOver = matchWinnerId != null;
    this.phaseEndsAt = Date.now() + (matchOver ? MATCH_RESULT_PAUSE_MS : RESULT_PAUSE_MS);

    const score = this.playerOrder.map((id) => ({
      id,
      name: this.players.get(id).username,
      sets: this.setScore[id],
    }));

    this.io.to(this.channel).emit('roundResult', {
      winner,
      winnerId: setWinnerId,
      score,
      matchOver,
      matchWinnerId,
      matchWinnerName: matchOver ? this.players.get(matchWinnerId).username : null,
    });

    if (matchOver) {
      this._recordMatchResult(hunterId, runnerId, matchWinnerId).catch((err) => {
        console.error('Errore salvando il risultato della partita nel DB:', err);
      });
    }
  }

  async _recordMatchResult(hunterId, runnerId, matchWinnerId) {
    const p1 = this.players.get(this.playerOrder[0]);
    const p2 = this.players.get(this.playerOrder[1]);
    const loserId = this.playerOrder.find((id) => id !== matchWinnerId);
    const winnerUserId = this.players.get(matchWinnerId).userId;
    const loserUserId = this.players.get(loserId).userId;
    const winnerSets = this.setScore[matchWinnerId];
    const loserSets = this.setScore[loserId];

    await pool.query(
      `INSERT INTO matches (player1_id, player2_id, player1_sets, player2_sets, winner_id, started_via)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p1.userId, p2.userId, this.setScore[p1.socketId], this.setScore[p2.socketId], winnerUserId, this.startedVia]
    );
    await pool.query(
      'UPDATE users SET wins = wins + 1, sets_won = sets_won + $1, sets_lost = sets_lost + $2 WHERE id = $3',
      [winnerSets, loserSets, winnerUserId]
    );
    await pool.query(
      'UPDATE users SET losses = losses + 1, sets_won = sets_won + $1, sets_lost = sets_lost + $2 WHERE id = $3',
      [loserSets, winnerSets, loserUserId]
    );
  }

  _tick() {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;

    if (this.phase === 'countdown') {
      if (now >= this.phaseEndsAt) this._startRound();
    } else if (this.phase === 'playing') {
      for (const p of this.players.values()) this._movePlayer(p, dt);
      this._checkFruitPickups();
      this._checkCatches();
      if (this.phase === 'playing' && now >= this.roundEndsAt) this._endSet('runners');
    } else if (this.phase === 'ended') {
      if (now >= this.phaseEndsAt) {
        const matchIsOver = this.playerOrder.some((id) => this.setScore[id] >= SETS_TO_WIN);
        if (matchIsOver) {
          // segnale esplicito al client: "torna pure alla lobby", invece di
          // fargli indovinare quando siamo passati dal banner di fine
          // partita al vero smontaggio della Room
          this.io.to(this.channel).emit('matchEnded');
          this._end();
          return;
        }
        this.phase = 'countdown';
        this.phaseEndsAt = Date.now() + COUNTDOWN_MS;
        this._assignRolesForNewSet();
        this._resetFruits();
      }
    }

    this.pendingFruitRespawns = this.pendingFruitRespawns.filter((respawnAt) => {
      if (now < respawnAt) return true;
      this.fruits.push(spawnFruitPosition());
      return false;
    });

    this.io.to(this.channel).emit('state', {
      phase: this.phase,
      timeLeft: this.phase === 'playing' ? Math.max(0, this.roundEndsAt - now) : null,
      countdownLeft: this.phase === 'countdown' ? Math.max(0, this.phaseEndsAt - now) : null,
      arena: { w: ARENA_W, h: ARENA_H, obstacles: OBSTACLES },
      fruits: this.fruits.map((f) => ({ id: f.id, x: f.x, y: f.y })),
      match: {
        setsToWin: SETS_TO_WIN,
        players: this.playerOrder.map((id) => ({
          id,
          name: this.players.get(id).username,
          sets: this.setScore[id],
        })),
      },
      players: [...this.players.values()].map((p) => ({
        id: p.socketId,
        name: p.username,
        x: p.x,
        y: p.y,
        role: p.role,
        alive: p.alive,
        boosted: !!(p.boostUntil && now < p.boostUntil),
      })),
    });
  }

  _end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.interval);
    for (const socketId of this.playerOrder) {
      const s = this.io.sockets.sockets.get(socketId);
      if (s) {
        s.leave(this.channel);
        s.data.roomId = null;
      }
    }
    this.onEnded(this);
  }
}

module.exports = { Room, SETS_TO_WIN };
