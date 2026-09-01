// mailer.js — invio delle email di verifica account / reset password.
//
// Supporta due modi per mandare email vere (scegli uno, vedi .env.example):
//   - Resend (RESEND_API_KEY): un servizio con API HTTP, nessuna libreria
//     in più necessaria perché Node ha già "fetch" incorporato.
//   - SMTP qualsiasi (SMTP_HOST/PORT/USER/PASS), via nodemailer.
// Se non è configurato nessuno dei due (tipicamente in sviluppo locale),
// l'email non viene davvero spedita: il contenuto (link incluso) viene
// stampato nei log del server, così si può testare tutto il flusso senza
// configurare un provider vero.

const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || 'Acchiapparella <no-reply@acchiapparella.local>';

let smtpTransporter = null;
if (process.env.SMTP_HOST) {
  smtpTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function sendMail({ to, subject, text }) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ha risposto ${res.status}: ${body}`);
    }
    return;
  }

  if (smtpTransporter) {
    await smtpTransporter.sendMail({ from: FROM, to, subject, text });
    return;
  }

  console.log('\n📧 [EMAIL NON INVIATA — nessun provider configurato, vedi .env.example]');
  console.log(`   A: ${to}`);
  console.log(`   Oggetto: ${subject}`);
  console.log(`   ${text.split('\n').join('\n   ')}`);
  console.log('');
}

module.exports = { sendMail };
