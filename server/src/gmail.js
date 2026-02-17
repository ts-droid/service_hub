const { google } = require('googleapis');
const db = require('./db');
const { makeId, normalizeEmails, isInternal } = require('./utils');

const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GROUP_REPLY_FROM = {
  SUPPORT: process.env.GROUP_MAIL_SUPPORT || 'support@vendora.se',
  RMA: process.env.GROUP_MAIL_RMA || 'rma@vendora.se',
  FINANCE: process.env.GROUP_MAIL_FINANCE || 'invoice@vendora.se',
  LOGISTICS: process.env.GROUP_MAIL_LOGISTICS || 'logistics@vendora.se',
  MARKETING: process.env.GROUP_MAIL_MARKETING || 'marketing@vendora.se',
  SALES: process.env.GROUP_MAIL_SALES || 'sales@vendora.se'
};

function hasScope(scopeString, requiredScope) {
  return String(scopeString || '').split(/\s+/).includes(requiredScope);
}

function resolveStartTime() {
  const configured = process.env.START_TIME_ISO || '2026-02-11T20:00:00';
  const parsed = new Date(configured);
  const now = new Date();
  if (Number.isNaN(parsed.getTime())) {
    const fallback = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { configured, used: fallback, reason: 'invalid_config_fallback_30d' };
  }
  if (parsed.getTime() > now.getTime()) {
    const fallback = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { configured, used: fallback, reason: 'future_config_fallback_30d' };
  }
  return { configured, used: parsed, reason: 'configured' };
}

function getOauthClient(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

async function getUserToken(email) {
  const result = await db.query(
    'SELECT email, refresh_token, access_token, token_type, scope, expiry_date FROM user_oauth_tokens WHERE email = $1',
    [String(email || '').toLowerCase()]
  );
  return result.rows[0] || null;
}

async function getConfigKeywords() {
  const result = await db.query('SELECT key, value FROM config');
  const map = {};
  for (const row of result.rows) map[row.key] = row.value;
  const parse = (k) => (map[k] || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  return {
    keywordsRma: parse('KEYWORDS_RMA'),
    keywordsFinance: parse('KEYWORDS_FINANCE'),
    keywordsLogistics: parse('KEYWORDS_LOGISTICS'),
    keywordsMarketing: parse('KEYWORDS_MARKETING'),
    keywordsSales: parse('KEYWORDS_SALES'),
    keywordsSupport: parse('KEYWORDS_SUPPORT')
  };
}

async function inferGroup(recipient, subject, body) {
  const r = (recipient || '').toLowerCase();
  const content = `${subject || ''} ${body || ''}`.toLowerCase();

  const keys = await getConfigKeywords();
  // Primary classifier: keywords in subject/body.
  if (keys.keywordsRma.some(k => content.includes(k))) return 'RMA';
  if (keys.keywordsFinance.some(k => content.includes(k))) return 'FINANCE';
  if (keys.keywordsLogistics.some(k => content.includes(k))) return 'LOGISTICS';
  if (keys.keywordsSales.some(k => content.includes(k))) return 'SALES';
  if (keys.keywordsMarketing.some(k => content.includes(k))) return 'MARKETING';
  if (keys.keywordsSupport.some(k => content.includes(k))) return 'SUPPORT';

  // Fallback: infer from addressed mailbox alias.
  if (r.includes('rma@vendora.se')) return 'RMA';
  if (r.includes('invoice@vendora.se')) return 'FINANCE';
  if (r.includes('logistics@vendora.se')) return 'LOGISTICS';
  if (r.includes('sales@vendora.se')) return 'SALES';
  if (r.includes('marketing@vendora.se')) return 'MARKETING';
  if (r.includes('support@vendora.se')) return 'SUPPORT';
  return null;
}

async function fetchNewEmails() {
  const usersRes = await db.query(
    "SELECT email, refresh_token, scope FROM user_oauth_tokens WHERE refresh_token IS NOT NULL AND refresh_token <> ''"
  );
  const users = usersRes.rows.filter(u => hasScope(u.scope, GMAIL_READ_SCOPE));
  if (!users.length) return { ok: false, reason: 'no users with gmail.readonly consent' };

  const stats = {
    usersScanned: users.length,
    threadsListed: 0,
    threadsFetched: 0,
    inserted: 0,
    skippedExistingThread: 0,
    skippedInternalSender: 0,
    skippedBlacklistedSender: 0,
    skippedMissingSender: 0,
    skippedNoGroup: 0,
    userListErrors: 0,
    threadFetchErrors: 0,
    userListErrorDetails: [],
    samples: {
      skippedExistingThread: [],
      skippedInternalSender: [],
      skippedBlacklistedSender: [],
      skippedNoGroup: []
    }
  };
  const MAX_SAMPLE = 5;
  const MAX_THREADS_PER_USER = 250;

  const startInfo = resolveStartTime();
  const afterDate = startInfo.used;
  const yyyy = afterDate.getUTCFullYear();
  const mm = String(afterDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(afterDate.getUTCDate()).padStart(2, '0');
  // Read all incoming messages in connected mailboxes, not only shared-group aliases.
  const query = `after:${yyyy}/${mm}/${dd} -in:chats -in:drafts -in:trash`;

  const existingThreads = await db.query('SELECT thread_id FROM tickets');
  const existingSet = new Set(existingThreads.rows.map(r => r.thread_id));

  const blacklistRows = await db.query('SELECT email FROM blacklist');
  const blacklist = new Set(blacklistRows.rows.map(r => String(r.email).toLowerCase()));

  let created = 0;

  for (const user of users) {
    const oauth2Client = getOauthClient(user.refresh_token);
    if (!oauth2Client) continue;
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let threads = [];
    try {
      let pageToken = undefined;
      do {
        const threadsRes = await gmail.users.threads.list({
          userId: 'me',
          q: query,
          maxResults: 100,
          pageToken
        });
        const pageThreads = threadsRes.data.threads || [];
        threads.push(...pageThreads);
        pageToken = threadsRes.data.nextPageToken;
      } while (pageToken && threads.length < MAX_THREADS_PER_USER);
      threads = threads.slice(0, MAX_THREADS_PER_USER);
      stats.threadsListed += threads.length;
    } catch (err) {
      stats.userListErrors += 1;
      const detail =
        err?.response?.data?.error?.message ||
        err?.response?.data?.error_description ||
        err?.message ||
        'unknown_list_error';
      stats.userListErrorDetails.push({ email: user.email, error: detail });
      continue;
    }

    for (const t of threads) {
      if (existingSet.has(t.id)) {
        stats.skippedExistingThread += 1;
        if (stats.samples.skippedExistingThread.length < MAX_SAMPLE) {
          stats.samples.skippedExistingThread.push({ threadId: t.id });
        }
        continue;
      }

      let thread;
      try {
        thread = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' });
        stats.threadsFetched += 1;
      } catch (err) {
        stats.threadFetchErrors += 1;
        continue;
      }

      const messages = thread.data.messages || [];
      if (!messages.length) continue;

      const last = messages[messages.length - 1];
      const headers = last.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const from = getHeader('From');
      const to = getHeader('To');
      const subject = getHeader('Subject');
      const sender = normalizeEmails(from)[0];
      if (!sender) {
        stats.skippedMissingSender += 1;
        continue;
      }
      if (isInternal(from)) {
        stats.skippedInternalSender += 1;
        if (stats.samples.skippedInternalSender.length < MAX_SAMPLE) {
          stats.samples.skippedInternalSender.push({ threadId: t.id, from, subject });
        }
        continue;
      }
      if (blacklist.has(sender.toLowerCase())) {
        stats.skippedBlacklistedSender += 1;
        if (stats.samples.skippedBlacklistedSender.length < MAX_SAMPLE) {
          stats.samples.skippedBlacklistedSender.push({ threadId: t.id, sender, subject });
        }
        continue;
      }

      const body = extractPlainBody(last.payload);
      const grp = await inferGroup(to, subject, body);
      if (!grp) {
        stats.skippedNoGroup += 1;
        if (stats.samples.skippedNoGroup.length < MAX_SAMPLE) {
          stats.samples.skippedNoGroup.push({ threadId: t.id, from, to, subject });
        }
        continue;
      }

      const ticketId = makeId('VEN');
      const now = new Date().toISOString();
      const lastDate = last.internalDate ? new Date(Number(last.internalDate)).toISOString() : now;

      const insertTicket = await db.query(
        `INSERT INTO tickets
          (ticket_id, created_at, updated_at, subject, status, priority, "group", owner_email, sender_email, thread_id, last_message_at, tags)
         VALUES
          ($1,$2,$3,$4,'Nytt','Normal',$5,NULL,$6,$7,$8,'')
         ON CONFLICT (thread_id) DO NOTHING`,
        [ticketId, now, now, `[${ticketId}] ${subject || ''}`.trim(), grp, sender, t.id, lastDate]
      );
      if (!insertTicket.rowCount) {
        existingSet.add(t.id);
        stats.skippedExistingThread += 1;
        continue;
      }

      for (const m of messages) {
        const mh = m.payload?.headers || [];
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

      existingSet.add(t.id);
      created += 1;
      stats.inserted += 1;
    }
  }

  return {
    ok: true,
    created,
    query,
    startTimeConfigured: startInfo.configured,
    startTimeUsed: startInfo.used.toISOString(),
    startTimeReason: startInfo.reason,
    stats
  };
}

function getGroupReplyAddress(groupName) {
  return GROUP_REPLY_FROM[String(groupName || '').toUpperCase()] || null;
}

async function sendMessage(gmail, fromAddress, to, subject, body, threadId) {
  const message = [
    `From: ${fromAddress}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body
  ].join('\r\n');

  const raw = Buffer.from(message).toString('base64url');
  return gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: threadId || undefined
    }
  });
}

async function sendReplyFromUser(userEmail, ticketId, to, subject, body, threadId, ticketGroup) {
  const token = await getUserToken(userEmail);
  if (!token || !token.refresh_token) return { ok: false, error: 'gmail not connected for user' };
  if (!hasScope(token.scope, GMAIL_SEND_SCOPE)) return { ok: false, error: 'gmail.send scope missing' };

  const oauth2Client = getOauthClient(token.refresh_token);
  if (!oauth2Client) return { ok: false, error: 'oauth client unavailable' };
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const safeSubject = subject && subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject || ''}`;
  const preferredFrom = getGroupReplyAddress(ticketGroup);
  const fallbackFrom = userEmail;
  let sent;
  let sentFrom = fallbackFrom;

  try {
    if (preferredFrom && preferredFrom.toLowerCase() !== fallbackFrom.toLowerCase()) {
      try {
        sent = await sendMessage(gmail, preferredFrom, to, safeSubject, body, threadId);
        sentFrom = preferredFrom;
      } catch (err) {
        sent = await sendMessage(gmail, fallbackFrom, to, safeSubject, body, threadId);
      }
    } else {
      sent = await sendMessage(gmail, fallbackFrom, to, safeSubject, body, threadId);
    }

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO messages
        (message_id, ticket_id, date, "from", "to", subject, body, gmail_message_id, thread_id)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [makeId('MSG'), ticketId, now, sentFrom, to, safeSubject, body, sent.data.id || null, threadId || null]
    );

    return { ok: true, messageId: sent.data.id || null, sentFrom };
  } catch (err) {
    return { ok: false, error: 'gmail send failed' };
  }
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
  fetchNewEmails,
  sendReplyFromUser,
  GMAIL_READ_SCOPE,
  GMAIL_SEND_SCOPE
};
