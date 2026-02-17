require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('./db');
const { GROUPS, makeId, nowIso } = require('./utils');
const { requireAuth, requireAdmin, requireJobToken } = require('./middleware');
const { fetchNewEmails, sendReplyFromUser, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } = require('./gmail');
const { getGeminiResponse } = require('./gemini');
const { getOauthClient } = require('./google-oauth');
const { signUser, setSessionCookie, clearSessionCookie } = require('./auth');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static('public'));

async function logSyncRun(source, userEmail, payload) {
  const details = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await db.query(
    'INSERT INTO logs (ticket_id, user_email, action, details) VALUES ($1,$2,$3,$4)',
    [null, userEmail || null, 'GMAIL_SYNC', `[${source}] ${details}`]
  );
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/', async (req, res) => {
  try {
    const token = req.cookies?.vendora_session || '';
    if (!token) return res.sendFile('landing.html', { root: 'public' });
    const { verifyToken } = require('./auth');
    const user = verifyToken(token);
    const result = await db.query('SELECT user_id FROM users WHERE email = $1', [user.email]);
    if (!result.rows[0]) return res.sendFile('landing.html', { root: 'public' });
    return res.sendFile('index.html', { root: 'public' });
  } catch (err) {
    return res.sendFile('landing.html', { root: 'public' });
  }
});

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile('admin.html', { root: 'public' });
});

app.get('/me', requireAuth, async (req, res) => {
  const email = req.user.email.toLowerCase();
  const userRes = await db.query('SELECT name, email, "group", role, active FROM users WHERE email = $1', [email]);
  const oauthRes = await db.query('SELECT scope, refresh_token FROM user_oauth_tokens WHERE email = $1', [email]);
  const scope = oauthRes.rows[0]?.scope || '';
  const gmailConnected = !!oauthRes.rows[0]?.refresh_token;
  const adminList = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const isAdmin = adminList.includes(email) || (userRes.rows[0] && String(userRes.rows[0].role).toLowerCase() === 'admin');
  res.json({
    email,
    name: req.user.name || userRes.rows[0]?.name || '',
    isRegistered: !!userRes.rows[0],
    isAdmin,
    group: userRes.rows[0]?.group || '',
    gmailConnected,
    gmailReadEnabled: scope.includes(GMAIL_READ_SCOPE),
    gmailSendEnabled: scope.includes(GMAIL_SEND_SCOPE)
  });
});

app.get('/auth/google', (req, res) => {
  const client = getOauthClient();
  if (!client) return res.status(500).send('Google OAuth is not configured');
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    GMAIL_READ_SCOPE,
    GMAIL_SEND_SCOPE
  ];
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const client = getOauthClient();
  if (!client) return res.status(500).send('Google OAuth is not configured');
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2 = require('googleapis').google.oauth2({ auth: client, version: 'v2' });
    const me = await oauth2.userinfo.get();
    const email = (me.data.email || '').toLowerCase();
    const name = me.data.name || '';

    if (!email || !email.endsWith(`@${process.env.ALLOWED_DOMAIN || 'vendora.se'}`)) {
      return res.status(403).send('Åtkomst nekad');
    }

    const currentTokenRes = await db.query('SELECT refresh_token, scope FROM user_oauth_tokens WHERE email = $1', [email]);
    const existingRefresh = currentTokenRes.rows[0]?.refresh_token || null;
    const refreshToken = tokens.refresh_token || existingRefresh;
    const scope = tokens.scope || currentTokenRes.rows[0]?.scope || '';
    const expiryIso = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;

    await db.query(
      `INSERT INTO user_oauth_tokens
        (email, refresh_token, access_token, token_type, scope, expiry_date, updated_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email) DO UPDATE SET
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        token_type = EXCLUDED.token_type,
        scope = EXCLUDED.scope,
        expiry_date = EXCLUDED.expiry_date,
        updated_at = EXCLUDED.updated_at`,
      [email, refreshToken, tokens.access_token || null, tokens.token_type || null, scope, expiryIso, nowIso()]
    );

    const token = signUser({ email, name });
    setSessionCookie(res, token);
    return res.redirect('/');
  } catch (err) {
    return res.status(500).send('OAuth failed');
  }
});

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/');
});

app.get('/groups', requireAuth, (req, res) => {
  res.json({ groups: ['Alla', ...GROUPS] });
});

app.post('/users/register', requireAuth, async (req, res) => {
  const { name, group } = req.body || {};
  if (!name || !group) return res.status(400).json({ error: 'name and group required' });

  const email = req.user.email;
  const existing = await db.query('SELECT user_id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) {
    await db.query('UPDATE users SET name = $1, "group" = $2 WHERE email = $3', [name, group, email]);
    await db.query('INSERT INTO logs (ticket_id, user_email, action, details) VALUES ($1,$2,$3,$4)', [null, email, 'USER_UPDATED', `Updated ${email}`]);
    return res.json({ ok: true });
  }

  await db.query(
    'INSERT INTO users (user_id, name, email, "group", role, active, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [makeId('USR'), name, email, group, 'User', true, nowIso()]
  );
  await db.query('INSERT INTO logs (ticket_id, user_email, action, details) VALUES ($1,$2,$3,$4)', [null, email, 'USER_CREATED', `Created ${email}`]);
  res.json({ ok: true });
});

app.get('/tickets', requireAuth, async (req, res) => {
  const { group, status } = req.query || {};
  const email = req.user.email;

  const users = await db.query('SELECT "group" FROM users WHERE email = $1', [email]);
  const userGroups = (users.rows[0]?.group || '').split(',').map(s => s.trim()).filter(Boolean);

  let where = [];
  let params = [];

  if (status) {
    if (status === 'Mina Pågående') {
      where.push('status = $' + (params.length + 1));
      params.push('Pågår');
      where.push('owner_email = $' + (params.length + 1));
      params.push(email);
    } else if (status !== 'Alla') {
      where.push('status = $' + (params.length + 1));
      params.push(status);
    }
  }

  if (!group || group === 'Alla') {
    if (userGroups.length) {
      where.push(`"group" = ANY($${params.length + 1})`);
      params.push(userGroups);
    }
  } else {
    where.push('"group" = $' + (params.length + 1));
    params.push(group);
  }

  const sql = `SELECT ticket_id, subject, status, sender_email, "group", owner_email, priority, created_at
               FROM tickets
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY last_message_at DESC`;

  const result = await db.query(sql, params);
  res.json(result.rows.map(t => ({
    ID: t.ticket_id,
    Subject: t.subject,
    Status: t.status,
    Sender: t.sender_email,
    Group: t.group,
    Owner: t.owner_email,
    Priority: t.priority,
    CreatedAt: t.created_at
  })));
});

app.get('/tickets/:id', requireAuth, async (req, res) => {
  const ticketId = req.params.id;
  const email = req.user.email;

  const ticketRes = await db.query('SELECT status, owner_email FROM tickets WHERE ticket_id = $1', [ticketId]);
  if (!ticketRes.rows[0]) return res.status(404).json({ error: 'not found' });

  if (ticketRes.rows[0].status === 'Nytt') {
    await db.query('UPDATE tickets SET status = $1, owner_email = $2, updated_at = $3 WHERE ticket_id = $4', ['Pågår', email, nowIso(), ticketId]);
  }

  const msgRes = await db.query('SELECT "from", date, body FROM messages WHERE ticket_id = $1 ORDER BY date ASC', [ticketId]);
  res.json({
    messages: msgRes.rows.map(m => ({ from: m.from, date: m.date, body: m.body || 'Ingen text tillgänglig.' }))
  });
});

app.post('/tickets/:id/reply', requireAuth, async (req, res) => {
  const ticketId = req.params.id;
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  const ticketRes = await db.query('SELECT subject, sender_email, thread_id, "group" FROM tickets WHERE ticket_id = $1', [ticketId]);
  if (!ticketRes.rows[0]) return res.status(404).json({ error: 'ticket not found' });
  const ticket = ticketRes.rows[0];

  const sendResult = await sendReplyFromUser(
    req.user.email,
    ticketId,
    ticket.sender_email,
    ticket.subject,
    text,
    ticket.thread_id,
    ticket.group
  );
  if (!sendResult.ok) return res.status(400).json({ error: sendResult.error });

  await db.query('UPDATE tickets SET status = $1, updated_at = $2, last_message_at = $3 WHERE ticket_id = $4', ['Väntar', nowIso(), nowIso(), ticketId]);
  await db.query(
    'INSERT INTO logs (ticket_id, user_email, action, details) VALUES ($1,$2,$3,$4)',
    [ticketId, req.user.email, 'REPLY', `Reply sent from ${sendResult.sentFrom || req.user.email}`]
  );
  res.json({ ok: true });
});

app.post('/tickets/:id/move', requireAuth, async (req, res) => {
  const ticketId = req.params.id;
  const group = req.body?.group;
  if (!group) return res.status(400).json({ error: 'group required' });

  await db.query(
    'UPDATE tickets SET "group" = $1, owner_email = NULL, status = $2, updated_at = $3 WHERE ticket_id = $4',
    [group, 'Nytt', nowIso(), ticketId]
  );
  res.json({ ok: true });
});

app.post('/tickets/:id/block', requireAuth, async (req, res) => {
  const ticketId = req.params.id;
  const email = (req.body?.email || '').toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });

  await db.query('INSERT INTO blacklist (email, blocked_at) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING', [email, nowIso()]);
  await db.query('UPDATE tickets SET status = $1, updated_at = $2 WHERE ticket_id = $3', ['Löst', nowIso(), ticketId]);
  res.json({ ok: true });
});

app.post('/tickets/:id/status', requireAuth, async (req, res) => {
  const ticketId = req.params.id;
  const status = req.body?.status;
  if (!status) return res.status(400).json({ error: 'status required' });

  await db.query('UPDATE tickets SET status = $1, updated_at = $2 WHERE ticket_id = $3', [status, nowIso(), ticketId]);
  res.json({ ok: true });
});

app.post('/ai/gemini', requireAuth, async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  const result = await getGeminiResponse(text);
  if (!result.ok) return res.status(500).json({ error: result.error });
  res.json({ text: result.text });
});

app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.query('SELECT name, email, "group", role, active FROM users ORDER BY name ASC');
  res.json(result.rows);
});

app.delete('/admin/users/:email', requireAuth, requireAdmin, async (req, res) => {
  const email = req.params.email.toLowerCase();
  await db.query('DELETE FROM users WHERE email = $1', [email]);
  res.json({ ok: true });
});

app.get('/admin/blacklist', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.query('SELECT email, blocked_at FROM blacklist ORDER BY blocked_at DESC');
  res.json(result.rows);
});

app.delete('/admin/blacklist/:email', requireAuth, requireAdmin, async (req, res) => {
  const email = req.params.email.toLowerCase();
  await db.query('DELETE FROM blacklist WHERE email = $1', [email]);
  res.json({ ok: true });
});

app.get('/admin/config', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.query('SELECT key, value FROM config ORDER BY key ASC');
  res.json(result.rows);
});

app.post('/admin/config', requireAuth, requireAdmin, async (req, res) => {
  const key = (req.body?.key || '').trim();
  const value = (req.body?.value || '').trim();
  if (!key) return res.status(400).json({ error: 'key required' });

  await db.query(
    'INSERT INTO config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
  res.json({ ok: true });
});

app.put('/admin/users/:email', requireAuth, requireAdmin, async (req, res) => {
  const email = req.params.email.toLowerCase();
  const name = (req.body?.name || '').trim();
  const group = (req.body?.group || '').trim();
  const role = (req.body?.role || '').trim();
  const active = req.body?.active;

  if (!name || !group || !role) return res.status(400).json({ error: 'name, group, role required' });

  await db.query(
    'UPDATE users SET name = $1, "group" = $2, role = $3, active = $4 WHERE email = $5',
    [name, group, role, active !== undefined ? !!active : true, email]
  );
  res.json({ ok: true });
});

app.post('/jobs/gmail-sync', requireJobToken, async (req, res) => {
  try {
    const result = await fetchNewEmails();
    await logSyncRun('CRON', null, result);
    if (!result.ok) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    const payload = { ok: false, error: err?.message || 'sync_failed' };
    await logSyncRun('CRON', null, payload);
    res.status(500).json(payload);
  }
});

app.post('/admin/jobs/gmail-sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await fetchNewEmails();
    await logSyncRun('MANUAL', req.user.email, result);
    if (!result.ok) return res.status(500).json(result);
    res.json(result);
  } catch (err) {
    const payload = { ok: false, error: err?.message || 'sync_failed' };
    await logSyncRun('MANUAL', req.user.email, payload);
    res.status(500).json(payload);
  }
});

app.get('/admin/jobs/gmail-sync/latest', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.query(
    `SELECT timestamp, user_email, details
     FROM logs
     WHERE action = 'GMAIL_SYNC'
     ORDER BY timestamp DESC
     LIMIT 1`
  );
  if (!result.rows[0]) return res.json({ ok: true, latest: null });
  res.json({ ok: true, latest: result.rows[0] });
});

async function ensureRuntimeSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS user_oauth_tokens (
    email TEXT PRIMARY KEY,
    refresh_token TEXT,
    access_token TEXT,
    token_type TEXT,
    scope TEXT,
    expiry_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function start() {
  await ensureRuntimeSchema();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`API listening on ${port}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
