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

async function getGmailClientForEmail(email) {
  const token = await getUserToken(email);
  if (!token || !token.refresh_token) return null;
  if (!hasScope(token.scope, GMAIL_SEND_SCOPE)) return null;
  const oauth2Client = getOauthClient(token.refresh_token);
  if (!oauth2Client) return null;
  return google.gmail({ version: 'v1', auth: oauth2Client });
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

async function getGroupSignature(groupName) {
  const key = `SIGNATURE_${String(groupName || '').toUpperCase()}`;
  const result = await db.query('SELECT value FROM config WHERE key = $1', [key]);
  return String(result.rows[0]?.value || '').trim();
}

async function inferGroup(recipient, subject, body) {
  const r = (recipient || '').toLowerCase();
  const content = `${subject || ''} ${body || ''}`.toLowerCase();

  const keys = await getConfigKeywords();
  const hasKeyword = (kw) => keywordMatches(content, kw);
  // Primary classifier: keywords in subject/body.
  if (keys.keywordsRma.some(hasKeyword)) return 'RMA';
  if (keys.keywordsFinance.some(hasKeyword)) return 'FINANCE';
  if (keys.keywordsLogistics.some(hasKeyword)) return 'LOGISTICS';
  if (keys.keywordsSales.some(hasKeyword)) return 'SALES';
  if (keys.keywordsMarketing.some(hasKeyword)) return 'MARKETING';
  if (keys.keywordsSupport.some(hasKeyword)) return 'SUPPORT';

  // Fallback: infer from addressed mailbox alias.
  if (r.includes('rma@vendora.se')) return 'RMA';
  if (r.includes('invoice@vendora.se')) return 'FINANCE';
  if (r.includes('logistics@vendora.se')) return 'LOGISTICS';
  if (r.includes('sales@vendora.se')) return 'SALES';
  if (r.includes('marketing@vendora.se')) return 'MARKETING';
  if (r.includes('support@vendora.se')) return 'SUPPORT';
  return null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(content, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return false;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(kw)}(?=[^\\p{L}\\p{N}]|$)`, 'iu');
  return pattern.test(content);
}

function getHeaderValue(headers, name) {
  return (headers || []).find((h) => String(h.name || '').toLowerCase() === String(name || '').toLowerCase())?.value || '';
}

function normalizeMessageId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutBrackets = raw.replace(/^<+|>+$/g, '');
  return withoutBrackets.toLowerCase();
}

function isLikelyNewsletter(headers, from, subject, body) {
  const fromLc = String(from || '').toLowerCase();
  const subjectLc = String(subject || '').toLowerCase();
  const bodyLc = String(body || '').toLowerCase();

  const listUnsubscribe = getHeaderValue(headers, 'List-Unsubscribe');
  const listId = getHeaderValue(headers, 'List-Id');
  const precedence = getHeaderValue(headers, 'Precedence').toLowerCase();
  const autoSubmitted = getHeaderValue(headers, 'Auto-Submitted').toLowerCase();

  const hasListHeader = !!listUnsubscribe || !!listId || ['bulk', 'list', 'junk'].includes(precedence) || autoSubmitted === 'auto-generated';
  if (hasListHeader) return true;

  const hasNoReplySender = /no-?reply|newsletter|news@|hello@/.test(fromLc);
  const hasNewsletterTerms = [
    'unsubscribe',
    'avregistrera',
    'manage preferences',
    'view in browser',
    'nyhetsbrev',
    'kampanjer',
    'offers',
    'shop now'
  ].some((term) => bodyLc.includes(term) || subjectLc.includes(term));

  return hasNoReplySender && hasNewsletterTerms;
}

async function fetchNewEmails() {
  const usersRes = await db.query(
    "SELECT email, refresh_token, scope, created_at FROM user_oauth_tokens WHERE refresh_token IS NOT NULL AND refresh_token <> ''"
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
    skippedNewsletter: 0,
    skippedNoGroup: 0,
    skippedDuplicateMessageId: 0,
    userListErrors: 0,
    threadFetchErrors: 0,
    userListErrorDetails: [],
    samples: {
      skippedExistingThread: [],
      skippedInternalSender: [],
      skippedBlacklistedSender: [],
      skippedNewsletter: [],
      skippedNoGroup: [],
      skippedDuplicateMessageId: []
    }
  };
  const MAX_SAMPLE = 5;
  const MAX_THREADS_PER_USER = 250;

  const startInfo = resolveStartTime();

  const existingThreads = await db.query('SELECT thread_id FROM tickets');
  const existingSet = new Set(existingThreads.rows.map(r => r.thread_id));

  const blacklistRows = await db.query('SELECT email FROM blacklist');
  const blacklist = new Set(blacklistRows.rows.map(r => String(r.email).toLowerCase()));

  let created = 0;

  for (const user of users) {
    const userCreatedAt = user.created_at ? new Date(user.created_at) : null;
    const userStart = userCreatedAt && !Number.isNaN(userCreatedAt.getTime()) && userCreatedAt > startInfo.used
      ? userCreatedAt
      : startInfo.used;
    const yyyy = userStart.getUTCFullYear();
    const mm = String(userStart.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(userStart.getUTCDate()).padStart(2, '0');
    // For new users, start importing from their first OAuth connect time.
    const query = `after:${yyyy}/${mm}/${dd} -in:chats -in:drafts -in:trash`;

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
      const sourceMessageId = normalizeMessageId(getHeader('Message-ID'));
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
      if (isLikelyNewsletter(headers, from, subject, body)) {
        stats.skippedNewsletter += 1;
        if (stats.samples.skippedNewsletter.length < MAX_SAMPLE) {
          stats.samples.skippedNewsletter.push({ threadId: t.id, from, subject });
        }
        continue;
      }

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
          (ticket_id, created_at, updated_at, subject, status, priority, "group", owner_email, sender_email, thread_id, source_message_id, last_message_at, tags)
         VALUES
          ($1,$2,$3,$4,'Nytt','Normal',$5,NULL,$6,$7,$8,$9,'')
         ON CONFLICT DO NOTHING`,
        [ticketId, now, now, `[${ticketId}] ${subject || ''}`.trim(), grp, sender, t.id, sourceMessageId || null, lastDate]
      );
      if (!insertTicket.rowCount) {
        existingSet.add(t.id);
        if (sourceMessageId) {
          stats.skippedDuplicateMessageId += 1;
          if (stats.samples.skippedDuplicateMessageId.length < MAX_SAMPLE) {
            stats.samples.skippedDuplicateMessageId.push({ threadId: t.id, sourceMessageId, subject });
          }
        } else {
          stats.skippedExistingThread += 1;
        }
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

        const messageId = m.id ? `MSG-${m.id}` : makeId('MSG');
        await db.query(
          `INSERT INTO messages
            (message_id, ticket_id, date, "from", "to", subject, body, gmail_message_id, thread_id)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (message_id) DO NOTHING`,
          [messageId, ticketId, mDate, mFrom, mTo, mSubject, mBody, m.id, t.id]
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
    query: `after:${startInfo.used.getUTCFullYear()}/${String(startInfo.used.getUTCMonth() + 1).padStart(2, '0')}/${String(startInfo.used.getUTCDate()).padStart(2, '0')} -in:chats -in:drafts -in:trash`,
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
  const safeSubject = subject && subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject || ''}`;
  const preferredFrom = getGroupReplyAddress(ticketGroup);
  const fallbackFrom = userEmail;
  const signature = await getGroupSignature(ticketGroup);
  const signedBody = signature ? `${String(body || '').trim()}\n\n${signature}` : String(body || '').trim();
  const attempts = [];
  const sendCandidates = [];
  const seen = new Set();
  const addCandidate = (authEmail, label) => {
    const key = String(authEmail || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    sendCandidates.push({ authEmail: key, fromAddress: key, label });
  };
  addCandidate(preferredFrom, 'group');
  addCandidate(fallbackFrom, 'user');

  for (const candidate of sendCandidates) {
    const gmail = await getGmailClientForEmail(candidate.authEmail);
    if (!gmail) {
      attempts.push(`${candidate.label}:${candidate.authEmail}=no_oauth_or_scope`);
      continue;
    }

    try {
      let sent;
      try {
        sent = await sendMessage(gmail, candidate.fromAddress, to, safeSubject, signedBody, threadId);
      } catch (err) {
        const errCode = err?.response?.status;
        if (threadId && (errCode === 404 || String(err?.response?.data?.error?.message || '').toLowerCase().includes('thread'))) {
          sent = await sendMessage(gmail, candidate.fromAddress, to, safeSubject, signedBody, null);
        } else {
          throw err;
        }
      }

      const now = new Date().toISOString();
      const messageId = sent?.data?.id ? `MSG-${sent.data.id}` : makeId('MSG');
      await db.query(
        `INSERT INTO messages
          (message_id, ticket_id, date, "from", "to", subject, body, gmail_message_id, thread_id)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, ticketId, now, candidate.fromAddress, to, safeSubject, signedBody, sent.data.id || null, sent.data.threadId || threadId || null]
      );

      return { ok: true, messageId: sent.data.id || null, sentFrom: candidate.fromAddress };
    } catch (err) {
      const errText = err?.response?.data?.error?.message || err?.message || 'gmail send failed';
      attempts.push(`${candidate.label}:${candidate.authEmail}=${errText}`);
    }
  }

  return { ok: false, error: `gmail send failed (${attempts.join(' | ')})` };
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
