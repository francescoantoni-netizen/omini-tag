// server.js — il server autoritativo di Acchiapparella.
//
// Da questa versione in poi il gioco ha account veri (vedi auth.js) e
// funziona "come un sito di scacchi": ti registri, fai login, e poi o
// premi "trova avversario" (ti mette in coda finché non arriva qualcun
// altro in coda) oppure inviti un amico per username. Ogni partita 1v1 che
// parte è una game.js/Room indipendente — possono essercene tante insieme
// in contemporanea, una per ogni coppia che sta giocando in questo
// momento. Chi non sta giocando (in attesa in coda, o semplicemente
// collegato senza aver premuto nulla) non fa parte di nessuna Room: niente
// più "spettatori" dentro l'arena come nella versione precedente.

// { quiet: true }: le versioni recenti di dotenv stampano di default un
// "consiglio" pubblicitario casuale a ogni avvio — inutile qui, lo
// silenziamo e teniamo i log del server puliti.
require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const session = require('express-session');
const PgSessionStore = require('connect-pg-simple')(session);
const { Server } = require('socket.io');

const { pool, migrate } = require('./db');
const { router: authRouter, publicUser } = require('./auth');
const { Room } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const sessionMiddleware = session({
  store: new PgSessionStore({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // In produzione il sito gira dietro HTTPS (Render/Railway lo fanno da
    // soli): "secure" allora impedisce al browser di mandare il cookie su
    // una connessione non cifrata. In locale (http://localhost) invece
    // "secure" romperebbe tutto, perché non c'è HTTPS.
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // resti loggato per 30 giorni
  },
});

app.use(sessionMiddleware);
app.use('/api/auth', authRouter);

// La stessa identica sessione dei cookie HTTP è disponibile anche dentro
// Socket.io: così un socket "sa" già chi sei (niente più form "scrivi il
// tuo nome" per entrare in partita, come nella versione precedente).
io.engine.use(sessionMiddleware);

io.use(async (socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return next(new Error('unauthorized'));
  try {
    const result = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return next(new Error('unauthorized'));
    socket.data.user = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
});

// ---- Presenza / lobby ------------------------------------------------------
// presence: userId -> { socket, username, status }
//   status: 'idle' (collegato, non in coda né in partita) | 'queued' | 'in-room'
const presence = new Map();
// coda FIFO per "trova avversario": array di userId, in ordine di arrivo
const queue = [];
// inviti amico in sospeso: inviteId -> { fromUserId, toUserId, timeout }
const pendingInvites = new Map();
const INVITE_TTL_MS = 30 * 1000;

// rooms: roomId -> Room, tutte le partite 1v1 in corso in questo momento
const rooms = new Map();

function findPresenceByUsername(username) {
  const target = username.trim().toLowerCase();
  for (const p of presence.values()) {
    if (p.username.toLowerCase() === target) return p;
  }
  return null;
}

function clearInvitesInvolving(userId) {
  for (const [id, invite] of pendingInvites) {
    if (invite.fromUserId === userId || invite.toUserId === userId) {
      clearTimeout(invite.timeout);
      pendingInvites.delete(id);
      const otherUserId = invite.fromUserId === userId ? invite.toUserId : invite.fromUserId;
      const otherPresence = presence.get(otherUserId);
      if (otherPresence) {
        otherPresence.socket.emit('inviteError', { message: 'L\'invito non è più disponibile.' });
      }
    }
  }
}

function removeFromQueue(userId) {
  const idx = queue.indexOf(userId);
  if (idx !== -1) queue.splice(idx, 1);
}

function startRoom(entryA, entryB, startedVia) {
  const room = new Room(io, entryA, entryB, startedVia, onRoomEnded);
  rooms.set(room.id, room);
  presence.get(entryA.userId).status = 'in-room';
  presence.get(entryB.userId).status = 'in-room';
  entryA.socket.emit('matchStarting', { opponentUsername: entryB.username, startedVia });
  entryB.socket.emit('matchStarting', { opponentUsername: entryA.username, startedVia });
}

function onRoomEnded(room) {
  rooms.delete(room.id);
  for (const socketId of room.playerOrder) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) continue; // si è già disconnesso, la sua presenza è già stata ripulita altrove
    const pres = presence.get(s.data.user.id);
    if (pres && pres.socket.id === socketId) pres.status = 'idle';
  }
}

io.on('connection', (socket) => {
  const { id: userId, username } = socket.data.user;

  // Un utente può avere una sola connessione "attiva" alla volta (niente
  // supporto multi-scheda/multi-dispositivo in questa versione): se si
  // ricollega da un'altra scheda, quella vecchia viene chiusa.
  const already = presence.get(userId);
  if (already) {
    already.socket.emit('kicked', { message: 'Ti sei connesso da un\'altra scheda/dispositivo.' });
    already.socket.disconnect(true);
  }
  presence.set(userId, { socket, username, status: 'idle' });

  socket.on('findOpponent', () => {
    const me = presence.get(userId);
    if (!me || me.status !== 'idle') return;

    // cerca in coda qualcun altro ancora davvero disponibile (potrebbe
    // essersi disconnesso senza che la coda facesse in tempo a saperlo)
    while (queue.length > 0) {
      const candidateId = queue[0];
      if (candidateId === userId) { queue.shift(); continue; }
      const candidate = presence.get(candidateId);
      // chi è in coda ha per forza status 'queued' (non 'idle'): se non lo
      // trovo più così, vuol dire che quella entry è ormai "stantia" (si è
      // disconnesso, o è stato appena accoppiato da un'altra chiamata) e la
      // scarto invece di provare ad accoppiarci con lui
      if (!candidate || candidate.status !== 'queued') { queue.shift(); continue; }
      queue.shift();
      startRoom(
        { socket: candidate.socket, userId: candidateId, username: candidate.username },
        { socket, userId, username },
        'queue'
      );
      return;
    }

    queue.push(userId);
    me.status = 'queued';
    socket.emit('queued');
  });

  socket.on('cancelFindOpponent', () => {
    removeFromQueue(userId);
    const me = presence.get(userId);
    if (me && me.status === 'queued') me.status = 'idle';
    socket.emit('queueCancelled');
  });

  socket.on('inviteFriend', ({ username: targetUsername }) => {
    const me = presence.get(userId);
    if (!me || me.status !== 'idle') return;
    if (!targetUsername || typeof targetUsername !== 'string') return;
    if (targetUsername.trim().toLowerCase() === username.toLowerCase()) {
      socket.emit('inviteError', { message: 'Non puoi invitare te stesso.' });
      return;
    }

    const target = findPresenceByUsername(targetUsername);
    if (!target) {
      socket.emit('inviteError', { message: `${targetUsername} non è online in questo momento.` });
      return;
    }
    if (target.status !== 'idle') {
      socket.emit('inviteError', { message: `${target.username} non è disponibile ora.` });
      return;
    }

    const inviteId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingInvites.delete(inviteId);
      socket.emit('inviteError', { message: `${target.username} non ha risposto in tempo.` });
      target.socket.emit('inviteExpired', { fromUsername: username });
    }, INVITE_TTL_MS);
    pendingInvites.set(inviteId, { fromUserId: userId, toUserId: target.socket.data.user.id, timeout });

    target.socket.emit('inviteReceived', { inviteId, fromUsername: username });
    socket.emit('inviteSent', { toUsername: target.username });
  });

  socket.on('respondInvite', ({ inviteId, accept }) => {
    const invite = pendingInvites.get(inviteId);
    if (!invite || invite.toUserId !== userId) return;
    clearTimeout(invite.timeout);
    pendingInvites.delete(inviteId);

    const fromPresence = presence.get(invite.fromUserId);
    const mePresence = presence.get(userId);

    if (!accept) {
      if (fromPresence) fromPresence.socket.emit('inviteDeclined', { byUsername: username });
      return;
    }
    if (!fromPresence || fromPresence.status !== 'idle' || !mePresence || mePresence.status !== 'idle') {
      socket.emit('inviteError', { message: 'L\'invito non è più valido.' });
      return;
    }
    // se nel frattempo uno dei due si era anche messo in coda, esce da lì
    removeFromQueue(invite.fromUserId);
    removeFromQueue(userId);
    startRoom(
      { socket: fromPresence.socket, userId: invite.fromUserId, username: fromPresence.username },
      { socket, userId, username },
      'invite'
    );
  });

  socket.on('input', (input) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) room.handleInput(socket.id, input);
  });

  socket.on('disconnect', () => {
    const pres = presence.get(userId);
    // se "pres" non è più questa stessa socket, vuol dire che questo era il
    // socket VECCHIO scollegato dal ramo "already.socket.disconnect(true)"
    // qui sopra: la presenza vera ormai appartiene alla nuova connessione,
    // quindi non tocchiamo nulla.
    if (!pres || pres.socket.id !== socket.id) return;

    removeFromQueue(userId);
    clearInvitesInvolving(userId);
    if (socket.data.roomId) {
      const room = rooms.get(socket.data.roomId);
      if (room) room.handleDisconnect(socket.id);
    }
    presence.delete(userId);
  });
});

const PORT = process.env.PORT || 3000;

migrate()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server pronto su http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Impossibile avviare il server: la migrazione del database è fallita.', err);
    process.exit(1);
  });
