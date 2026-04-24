require('dotenv').config();

const express    = require('express');
const Database   = require('better-sqlite3');
const nodemailer = require('nodemailer');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'briefs.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS briefs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name  TEXT    NOT NULL,
    client_email TEXT    NOT NULL,
    brief_text   TEXT    NOT NULL,
    raw_data     TEXT    NOT NULL DEFAULT '{}',
    status       TEXT    NOT NULL DEFAULT 'new',
    created_at   DATETIME DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL TRANSPORTER
// ─────────────────────────────────────────────────────────────────────────────
let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

async function sendBriefEmail(name, email, brief) {
  const t = getTransporter();
  if (!t || !process.env.DESIGNER_EMAIL) return;

  const escaped = brief
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `
<div style="font-family:'Georgia',serif;max-width:640px;margin:40px auto;background:#faf8f5;border:1px solid #e3ddd3;border-radius:8px;overflow:hidden;">
  <div style="background:#1a1714;padding:28px 36px;">
    <p style="margin:0;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#8a857e;font-family:'DM Sans',sans-serif;">Logo Design Brief System</p>
    <h1 style="margin:8px 0 0;font-weight:300;font-size:26px;color:#faf8f5;letter-spacing:-.5px;">New Brief Received</h1>
  </div>
  <div style="padding:32px 36px;">
    <p style="font-size:14px;color:#4a4540;margin:0 0 6px;font-family:'DM Sans',sans-serif;">From</p>
    <p style="font-size:16px;font-weight:500;color:#1a1714;margin:0 0 24px;font-family:'DM Sans',sans-serif;">${name} &lt;${email}&gt;</p>
    <div style="background:#fff;border:1px solid #e3ddd3;border-radius:6px;padding:28px;">
      <pre style="font-family:'Courier New',monospace;font-size:13px;line-height:1.9;white-space:pre-wrap;margin:0;color:#1a1714;">${escaped}</pre>
    </div>
    <p style="font-size:12px;color:#8a857e;text-align:center;margin:24px 0 0;font-family:'DM Sans',sans-serif;">
      View and manage all briefs in your <a href="${process.env.APP_URL || ''}/admin" style="color:#b8973a;">admin panel</a>.
    </p>
  </div>
</div>`;

  await t.sendMail({
    from:    `"Brief System" <${process.env.SMTP_USER}>`,
    to:      process.env.DESIGNER_EMAIL,
    replyTo: email,
    subject: `✦ New Logo Brief — ${name}`,
    text:    `New brief from ${name} (${email}):\n\n${brief}`,
    html,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN AUTH
// ─────────────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY not configured.' });
  }
  const valid = crypto.timingSafeEqual(
    Buffer.from(key || ''),
    Buffer.from(process.env.ADMIN_KEY)
  );
  if (!valid) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/submit — Client submits brief
app.post('/api/submit', (req, res) => {
  try {
    const { brief, name, email, raw } = req.body;

    if (!brief || !name || !email)
      return res.status(400).json({ error: 'Missing required fields.' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email address.' });

    if (brief.length > 20000)
      return res.status(400).json({ error: 'Brief too long.' });

    const result = db.prepare(
      'INSERT INTO briefs (client_name, client_email, brief_text, raw_data) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), email.trim(), brief, JSON.stringify(raw || {}));

    // Fire-and-forget email
    sendBriefEmail(name, email, brief).catch(err =>
      console.warn('[email] Send failed (brief saved):', err.message)
    );

    console.log(`[brief] #${result.lastInsertRowid} — ${name} <${email}>`);
    res.json({ success: true, id: result.lastInsertRowid });

  } catch (err) {
    console.error('[submit]', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/stats
app.get('/api/stats', requireAdmin, (req, res) => {
  res.json({
    total:       db.prepare("SELECT COUNT(*) n FROM briefs").get().n,
    new:         db.prepare("SELECT COUNT(*) n FROM briefs WHERE status='new'").get().n,
    in_progress: db.prepare("SELECT COUNT(*) n FROM briefs WHERE status='in-progress'").get().n,
    completed:   db.prepare("SELECT COUNT(*) n FROM briefs WHERE status='completed'").get().n,
    archived:    db.prepare("SELECT COUNT(*) n FROM briefs WHERE status='archived'").get().n,
  });
});

// GET /api/briefs
app.get('/api/briefs', requireAdmin, (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT id, client_name, client_email, status, created_at FROM briefs WHERE 1=1';
  const params = [];
  if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  if (q) { sql += ' AND (client_name LIKE ? OR client_email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/briefs/:id
app.get('/api/briefs/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT * FROM briefs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json(row);
});

// PATCH /api/briefs/:id/status
app.patch('/api/briefs/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ['new', 'in-progress', 'completed', 'archived'];
  if (!allowed.includes(status))
    return res.status(400).json({ error: 'Invalid status.' });
  db.prepare('UPDATE briefs SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// DELETE /api/briefs/:id
app.delete('/api/briefs/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM briefs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPA FALLBACKS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('*', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n┌─────────────────────────────────────────┐');
  console.log(`│  Logo Brief App                          │`);
  console.log(`│  Client form  →  http://localhost:${PORT}   │`);
  console.log(`│  Admin panel  →  http://localhost:${PORT}/admin │`);
  console.log('└─────────────────────────────────────────┘\n');

  if (!process.env.ADMIN_KEY)
    console.warn('⚠  ADMIN_KEY not set — admin panel is unprotected!\n');
  if (!process.env.SMTP_USER)
    console.warn('⚠  SMTP not configured — emails will not be sent.\n');
});
