// auth.js — registrazione, verifica email, login/logout, reset password.
//
// Regole di sicurezza base seguite qui:
//   - le password non sono MAI salvate in chiaro, solo il loro hash bcrypt;
//   - i token (verifica email, reset password) non sono salvati in chiaro
//     nel database: si salva solo il loro hash SHA-256, così anche in caso
//     di fuga di dati dal DB nessuno può riusarli direttamente — solo chi
//     ha ricevuto l'email con il token vero può usarlo;
//   - i token scadono (24h per la verifica email, 1h per il reset password)
//     e sono "usa e getta" (un campo used_at li invalida dopo il primo uso);
//   - la risposta di "richiedi reset password" è sempre la stessa messaggio
//     di successo, che l'email esista o no nel database — altrimenti si
//     potrebbe usare quella form per scoprire quali email sono registrate.

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('./db');
const { sendMail } = require('./mailer');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    emailVerified: u.email_verified,
    stats: {
      wins: u.wins,
      losses: u.losses,
      setsWon: u.sets_won,
      setsLost: u.sets_lost,
    },
  };
}

async function sendVerificationEmail(user) {
  const token = generateToken();
  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '24 hours')`,
    [user.id, hashToken(token)]
  );
  const link = `${process.env.APP_BASE_URL}/?verifyToken=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Conferma il tuo account — Acchiapparella',
    text: `Ciao ${user.username},\n\nClicca qui per confermare il tuo indirizzo email e attivare l'account:\n${link}\n\nIl link scade tra 24 ore. Se non ti sei registrato tu, ignora questa email.`,
  });
}

// ---- Registrazione ---------------------------------------------------------
router.post('/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Lo username deve avere 3-20 caratteri: lettere, numeri o "_".' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Indirizzo email non valido.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La password deve avere almeno 8 caratteri.' });
  }

  const existing = await pool.query(
    'SELECT id FROM users WHERE username = $1 OR email = $2',
    [username, email]
  );
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Username o email già registrati.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
     RETURNING *`,
    [username, email, passwordHash]
  );
  const user = result.rows[0];

  try {
    await sendVerificationEmail(user);
  } catch (err) {
    console.error('Invio email di verifica fallito:', err);
    // l'account esiste comunque: l'utente potrà chiedere di rimandare
    // l'email di verifica più avanti
  }

  res.status(201).json({
    message: 'Account creato. Controlla la tua email per confermare l\'indirizzo prima di accedere.',
  });
});

// ---- Verifica email ---------------------------------------------------------
router.post('/verify-email', async (req, res) => {
  const token = String(req.body.token || '');
  if (!token) return res.status(400).json({ error: 'Token mancante.' });

  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT t.id AS token_id, t.user_id FROM email_verification_tokens t
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [tokenHash]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Link di verifica non valido o scaduto.' });
  }
  const { token_id, user_id } = result.rows[0];

  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user_id]);
  await pool.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [token_id]);

  res.json({ message: 'Email confermata! Ora puoi accedere.' });
});

router.post('/resend-verification', async (req, res) => {
  const emailOrUsername = String(req.body.emailOrUsername || '').trim().toLowerCase();
  if (!emailOrUsername) return res.status(400).json({ error: 'Manca username o email.' });

  const result = await pool.query(
    'SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1',
    [emailOrUsername]
  );
  const user = result.rows[0];
  // stessa risposta sia che l'utente esista sia che non esista/sia già
  // verificato, per non rivelare informazioni a chi indovina username/email
  if (user && !user.email_verified) {
    try {
      await sendVerificationEmail(user);
    } catch (err) {
      console.error('Invio email di verifica fallito:', err);
    }
  }
  res.json({ message: 'Se l\'account esiste ed è ancora da confermare, ti abbiamo mandato una nuova email.' });
});

// ---- Login / logout ---------------------------------------------------------
router.post('/login', async (req, res) => {
  const emailOrUsername = String(req.body.emailOrUsername || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const result = await pool.query(
    'SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1',
    [emailOrUsername]
  );
  const user = result.rows[0];
  if (!user) {
    return res.status(401).json({ error: 'Username/email o password sbagliati.' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Username/email o password sbagliati.' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Devi prima confermare la tua email — controlla la casella (o chiedi di rimandare l\'email).' });
  }

  // rigenera l'id di sessione al login: evita "session fixation" (un
  // eventuale id di sessione noto prima del login smette di essere valido)
  req.session.regenerate((err) => {
    if (err) {
      console.error('Errore rigenerando la sessione:', err);
      return res.status(500).json({ error: 'Errore interno, riprova.' });
    }
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ message: 'Uscito.' });
  });
});

router.get('/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non hai fatto login.' });
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: 'Non hai fatto login.' });
  res.json({ user: publicUser(user) });
});

// ---- Reset password ---------------------------------------------------------
router.post('/request-password-reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const generic = { message: 'Se l\'indirizzo è registrato, ti abbiamo mandato un\'email per reimpostare la password.' };
  if (!EMAIL_RE.test(email)) return res.json(generic); // stessa risposta anche se il formato è invalido

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (user) {
    const token = generateToken();
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [user.id, hashToken(token)]
    );
    const link = `${process.env.APP_BASE_URL}/?resetToken=${token}`;
    try {
      await sendMail({
        to: user.email,
        subject: 'Reimposta la password — Acchiapparella',
        text: `Ciao ${user.username},\n\nClicca qui per scegliere una nuova password:\n${link}\n\nIl link scade tra 1 ora. Se non sei stato tu, ignora questa email: la tua password resta quella di sempre.`,
      });
    } catch (err) {
      console.error('Invio email di reset fallito:', err);
    }
  }
  res.json(generic);
});

router.post('/reset-password', async (req, res) => {
  const token = String(req.body.token || '');
  const newPassword = String(req.body.newPassword || '');
  if (!token) return res.status(400).json({ error: 'Token mancante.' });
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'La nuova password deve avere almeno 8 caratteri.' });
  }

  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'Link di reset non valido o scaduto.' });
  }
  const { id: tokenId, user_id: userId } = result.rows[0];

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [tokenId]);
  // invalida anche eventuali altri link di reset ancora in giro per lo
  // stesso utente, non solo quello appena usato
  await pool.query(
    'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );

  res.json({ message: 'Password aggiornata. Ora puoi accedere con la nuova password.' });
});

module.exports = { router, publicUser };
