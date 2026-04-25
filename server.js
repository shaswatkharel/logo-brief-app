require('dotenv').config();

const express    = require('express');
const sqlite3    = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(path.join(__dirname, 'briefs.db'), err => {
  if (err) console.error('DB error:', err);
  else console.log('Database ready.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS briefs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name  TEXT    NOT NULL,
      client_email TEXT    NOT NULL,
      brief_text   TEXT    NOT NULL,
      raw_data     TEXT    NOT NULL DEFAULT '{}',
      status       TEXT    NOT NULL DEFAULT 'new',
      created_at   DATETIME DEFAULT (datetime('now'))
    )
  `);
});

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// ── EMAIL ─────────────────────────────────────────────────────────────────────
let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendBriefEmail(name, email, brief) {
  const t = getTransporter();
  if (!t || !process.env.DESIGNER_EMAIL) return;
  const escaped = brief.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const html = `
<div style="font-family:Georgia,serif;max-width:640px;margin:40px auto;background:#faf8f5;border:1px solid #e3ddd3;border-radius:8px;overflow:hidden">
  <div style="background:#1a1714;padding:28px 36px">
    <h1 style="margin:0;font-weight:300;font-size:26px;color:#faf8f5">New Logo Brief</h1>
    <p style="margin:6px 0 0;font-size:13px;color:#8a857e;font-family:sans-serif">From: ${name} &lt;${email}&gt;</p>
  </div>
  <div style="padding:32px 36px">
    <div style="background:#fff;border:1px solid #e3ddd3;border-radius:6px;padding:24px">
      <pre style="font-family:'Courier New',monospace;font-size:13px;line-height:1.9;white-space:pre-wrap;margin:0;color:#1a1714">${escaped}</pre>
    </div>
    <p style="font-size:12px;color:#8a857e;text-align:center;margin:20px 0 0;font-family:sans-serif">
      Admin panel: <a href="${process.env.APP_URL||''}/admin" style="color:#b8973a">${process.env.APP_URL||''}/admin</a>
    </p>
  </div>
</div>`;
  await t.sendMail({
    from: `"Brief System" <${process.env.SMTP_USER}>`,
    to: process.env.DESIGNER_EMAIL,
    replyTo: email,
    subject: `New Logo Brief — ${name}`,
    text: `New brief from ${name} (${email}):\n\n${brief}`,
    html,
  });
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH ──────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || '';
  if (!process.env.ADMIN_KEY)
    return res.status(500).json({ error: 'ADMIN_KEY not set.' });
  if (key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

// ── CLIENT API ────────────────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const { brief, name, email, raw } = req.body;
    if (!brief || !name || !email)
      return res.status(400).json({ error: 'Missing required fields.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email.' });

    const result = await dbRun(
      'INSERT INTO briefs (client_name, client_email, brief_text, raw_data) VALUES (?, ?, ?, ?)',
      [name.trim(), email.trim(), brief, JSON.stringify(raw || {})]
    );

    sendBriefEmail(name, email, brief).catch(e =>
      console.warn('[email] failed (brief saved):', e.message)
    );

    console.log(`[brief] #${result.lastID} — ${name} <${email}>`);
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    console.error('[submit]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── ADMIN API ─────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [total, newC, wip, done, arch] = await Promise.all([
      dbGet("SELECT COUNT(*) n FROM briefs"),
      dbGet("SELECT COUNT(*) n FROM briefs WHERE status='new'"),
      dbGet("SELECT COUNT(*) n FROM briefs WHERE status='in-progress'"),
      dbGet("SELECT COUNT(*) n FROM briefs WHERE status='completed'"),
      dbGet("SELECT COUNT(*) n FROM briefs WHERE status='archived'"),
    ]);
    res.json({ total: total.n, new: newC.n, in_progress: wip.n, completed: done.n, archived: arch.n });
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/briefs', requireAdmin, async (req, res) => {
  try {
    const { status, q } = req.query;
    let sql = 'SELECT id, client_name, client_email, status, created_at FROM briefs WHERE 1=1';
    const params = [];
    if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
    if (q) { sql += ' AND (client_name LIKE ? OR client_email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    sql += ' ORDER BY created_at DESC';
    res.json(await dbAll(sql, params));
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/briefs/:id', requireAdmin, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM briefs WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

app.patch('/api/briefs/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['new','in-progress','completed','archived'].includes(status))
    return res.status(400).json({ error: 'Invalid status.' });
  await dbRun('UPDATE briefs SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/briefs/:id', requireAdmin, async (req, res) => {
  await dbRun('DELETE FROM briefs WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ── SPA FALLBACKS ─────────────────────────────────────────────────────────────
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✓ Logo Brief App running on port ${PORT}\n`);
  if (!process.env.ADMIN_KEY) console.warn('⚠  ADMIN_KEY not set!');
  if (!process.env.SMTP_USER) console.warn('⚠  SMTP not configured.');
});
