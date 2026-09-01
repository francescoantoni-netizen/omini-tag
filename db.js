// db.js — connessione al database Postgres e schema delle tabelle.
//
// Niente framework di migrazioni vero (sarebbe overkill per questo
// progetto): all'avvio il server lancia semplicemente delle
// "CREATE TABLE IF NOT EXISTS", quindi la prima volta creano le tabelle e
// le volte dopo non fanno nulla. Se in futuro serve cambiare una colonna
// già esistente andrà scritto a mano, ma per aggiungere tabelle nuove
// questo basta e avanza.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'Manca DATABASE_URL nelle variabili d\'ambiente. In locale: copia .env.example in .env ' +
    '(node -r dotenv/config legge già .env automaticamente). In produzione: imposta DATABASE_URL ' +
    'con la stringa di connessione del tuo database Postgres (es. quella che ti dà Render/Railway/Supabase/Neon).'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Alcuni provider gestiti (Render, Supabase, Neon...) richiedono SSL ma
  // con un certificato che node non riconosce come "attendibile" di
  // default; in locale invece Postgres normalmente non usa SSL affatto.
  // DATABASE_SSL=require lo forza esplicitamente quando serve.
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  // un client "in idle" nel pool che va in errore non deve far crashare
  // tutto il server: lo logghiamo e basta, il pool ne aprirà uno nuovo al
  // prossimo utilizzo
  console.error('Errore imprevisto dal pool Postgres:', err);
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      sets_won INTEGER NOT NULL DEFAULT 0,
      sets_lost INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      player1_id INTEGER NOT NULL REFERENCES users(id),
      player2_id INTEGER NOT NULL REFERENCES users(id),
      player1_sets INTEGER NOT NULL,
      player2_sets INTEGER NOT NULL,
      winner_id INTEGER REFERENCES users(id),
      started_via TEXT NOT NULL DEFAULT 'queue',
      played_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Un indice per riga classifica ("chi ha vinto di più") non è
  // indispensabile alla scala di questo gioco, ma costa nulla aggiungerlo
  // ora piuttosto che accorgersene quando la tabella users è già grande.
  await pool.query(`CREATE INDEX IF NOT EXISTS users_wins_idx ON users (wins DESC);`);
}

module.exports = { pool, migrate };
