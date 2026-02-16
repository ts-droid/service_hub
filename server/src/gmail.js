const { google } = require('googleapis');
const db = require('./db');
const { makeId, normalizeEmails, isInternal } = require('./utils');

function getGmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function getConfigKeywords() {
  const result = await db.query('SELECT key, value FROM config');
  const map = {};
  for (const row of result.rows) {
    map[row.key] = row.value;
  }
  const parse = (k) => (map[k] || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  return {
    keywordsRma: parse('KEYWORDS_RMA'),
    keywordsFinance: parse('KEYWORDS_FINANCE'),
    keywordsLogistics: parse('KEYWORDS_LOGISTICS'),
    keywordsSupport: parse('KEYWORDS_SUPPORT')
  };
}

async function inferGroup(recipient, subject, body) {
  const r = (recipient || '').toLowerCase();
  const content = `${subject || ''} ${body || ''}`.toLowerCase();
  if (r.includes('rma@vendora.se')) return 'RMA';
  if (r.includes('invoice@vendora.se')) return 'FINANCE';
  if (r.includes('logistics@vendora.se')) return 'LOGISTICS';
  if (r.includes('sales@vendora.se')) return 'SALES';
  if (r.includes('marketing@vendora.se')) return 'MARKETING';
  if (r.includes('support@vendora.se')) return 'SUPPORT';

  const keys = await getConfigKeywords();
  if (keys.keywordsRma.some(k => content.includes(k))) return 'RMA';
  if (keys.keywordsFinance.some(k => content.includes(k))) return 'FINANCE';
  if (keys.keywordsLogistics.some(k => content.includes(k))) return 'LOGISTICS';
  if (keys.keywordsSupport.some(k => content.includes(k))) return 'SUPPORT';

  return null;
}

async function fetchNewEmails() {
  const gmail = getGmailClient();
  if (!gmail) {
    return { ok: false, reason: 'gmail credentials missing' };
  }

  const startTime = process.env.START_TIME_ISO || '2026-02-11T20:00:00';
  const afterDate = new Date(startTime);
  const yyyy = afterDate.getUTCFullYear();
  const mm = String(afterDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(afterDate.getUTCDate()).padStart(2, '0');

  const query = `after:${yyyy}/${mm}/${dd} (to:support@vendora.se OR to:rma@vendora.se OR to:logistics@vendora.se OR to:invoice@vendora.se OR to:sales@vendora.se OR to:marketing@vendora.se)`;

  const existingThreads = await db.query('SELECT thread_id FROM tickets');
  const existingSet = new Set(existingThreads.rows.map(r => r.thread_id));

  const blacklistRows = await db.query('SELECT email FROM blacklist');
  const blacklist = new Set(blacklistRows.rows.map(r => String(r.email).toLowerCase()));

  const threadsRes = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: 50 });
  const threads = threadsRes.data.threads || [];

  let created = 0;

  for (const t of threads) {
    if (existingSet.has(t.id)) continue;

    const thread = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' });
    const messages = thread.data.messages || [];
    if (!messages.length) continue;

    const last = messages[messages.length - 1];
    const headers = last.payload.headers || [];
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const from = getHeader('From');
    const to = getHeader('To');
    const subject = getHeader('Subject');
    const sender = normalizeEmails(from)[0];
    if (!sender) continue;
    if (isInternal(from)) continue;
    if (blacklist.has(sender.toLowerCase())) continue;

    const body = extractPlainBody(last.payload);
    const grp = await inferGroup(to, subject, body);
    if (!grp) continue;

    const ticketId = makeId('VEN');
    const now = new Date().toISOString();
    const lastDate = last.internalDate ? new Date(Number(last.internalDate)).toISOString() : now;

    await db.query(
      `INSERT INTO tickets
        (ticket_id, created_at, updated_at, subject, status, priority, "group", owner_email, sender_email, thread_id, last_message_at, tags)
       VALUES
        ($1,$2,$3,$4,'Nytt','Normal',$5,NULL,$6,$7,$8,'')`,
      [ticketId, now, now, `[${ticketId}] ${subject || ''}`.trim(), grp, sender, t.id, lastDate]
    );

    for (const m of messages) {
      const mh = m.payload.headers || [];
      const gh = (name) => mh.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
      const mFrom = gh('From');
      const mTo = gh('To');
      const mSubject = gh('Subject');
      const mBody = extractPlainBody(m.payload);
      const mDate = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : now;

      await db.query(
        `INSERT INTO messages
          (message_id, ticket_id, date, "from", "to", subject, body, gmail_message_id, thread_id)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [makeId('MSG'), ticketId, mDate, mFrom, mTo, mSubject, mBody, m.id, t.id]
      );
    }

    created += 1;
  }

  return { ok: true, created };
}

function extractPlainBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  const parts = payload.parts || [];
  for (const p of parts) {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      return Buffer.from(p.body.data, 'base64').toString('utf8');
    }
  }
  return '';
}

module.exports = {
  fetchNewEmails
};
