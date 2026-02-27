const ENABLED = () => !!String(process.env.SLACK_WEBHOOK_URL || '').trim();
const DM_ENABLED = () => !!String(process.env.SLACK_BOT_TOKEN || '').trim();

async function postSlack(payload) {
  const webhook = String(process.env.SLACK_WEBHOOK_URL || '').trim();
  if (!webhook) return { ok: false, skipped: true, reason: 'missing_webhook' };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Slack webhook ${res.status}: ${body || 'unknown error'}`);
    }
    return { ok: true };
  } catch (err) {
    console.error('[slack] post failed:', err.message || err);
    return { ok: false, error: err.message || 'post_failed' };
  }
}

async function postSlackDm(memberId, payload) {
  const token = String(process.env.SLACK_BOT_TOKEN || '').trim();
  if (!token) return { ok: false, skipped: true, reason: 'missing_bot_token' };
  const channel = String(memberId || '').trim();
  if (!channel) return { ok: false, skipped: true, reason: 'missing_member_id' };

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ channel, ...payload })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      throw new Error(`Slack DM failed: ${json.error || res.status}`);
    }
    return { ok: true };
  } catch (err) {
    console.error('[slack] dm failed:', err.message || err);
    return { ok: false, error: err.message || 'dm_failed' };
  }
}

function trunc(v, n = 120) {
  const s = String(v || '').trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function getSlackMention(email) {
  const mapRaw = String(process.env.SLACK_MENTION_MAP || '').trim();
  if (!mapRaw || !email) return '';
  const pairs = mapRaw.split(',').map((p) => p.trim()).filter(Boolean);
  const map = new Map();
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map.get(String(email).toLowerCase()) || '';
}

function isValidSlackMemberId(value) {
  return /^U[A-Z0-9]+$/.test(String(value || '').trim().toUpperCase());
}

async function notifyTicketCreated(data) {
  if (!ENABLED()) return;
  await postSlack({
    text: `Nytt ärende: ${data.ticketId} (${data.group})`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:incoming_envelope: *Nytt ärende* \`${data.ticketId}\`` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Grupp:* ${data.group}\n*Avsändare:* ${data.senderEmail}\n*Ämne:* ${trunc(data.subject, 180)}` } }
    ]
  });
}

async function notifyTicketMoved(data) {
  if (!ENABLED()) return;
  await postSlack({
    text: `Ärende flyttat: ${data.ticketId} -> ${data.group}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:twisted_rightwards_arrows: *Ärende flyttat* \`${data.ticketId}\`` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Ny grupp:* ${data.group}\n*Gjort av:* ${data.actorEmail}` } }
    ]
  });
}

async function notifyTicketAssigned(data) {
  const ownerText = data.ownerEmail ? data.ownerEmail : 'Ej tilldelad';
  const mention = isValidSlackMemberId(data.slackMemberId)
    ? `<@${String(data.slackMemberId).trim().toUpperCase()}>`
    : getSlackMention(data.ownerEmail);
  const assignedLine = mention ? `*Tilldelad:* ${ownerText} (${mention})` : `*Tilldelad:* ${ownerText}`;
  let channelRes = { ok: false, skipped: true, reason: 'missing_webhook' };
  if (ENABLED()) {
    channelRes = await postSlack({
      text: `Tilldelning: ${data.ticketId} -> ${ownerText}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:bust_in_silhouette: *Tilldelning ändrad* \`${data.ticketId}\`` } },
        { type: 'section', text: { type: 'mrkdwn', text: `${assignedLine}\n*Grupp:* ${data.group || '-'}\n*Gjort av:* ${data.actorEmail}` } }
      ]
    });
  }
  let dmRes = { ok: false, skipped: true, reason: 'not_requested' };
  if (isValidSlackMemberId(data.slackMemberId) && DM_ENABLED()) {
    dmRes = await postSlackDm(String(data.slackMemberId).trim().toUpperCase(), {
      text: `Du har tilldelats ärende ${data.ticketId} (${data.group || '-'})`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `:bell: Du har blivit tilldelad ärende \`${data.ticketId}\`` }
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Grupp:* ${data.group || '-'}\n*Tilldelad av:* ${data.actorEmail}` }
        }
      ]
    });
  }
  return { ok: true, channel: channelRes, dm: dmRes };
}

async function notifyTicketStatusChanged(data) {
  if (!ENABLED()) return;
  await postSlack({
    text: `Status ändrad: ${data.ticketId} -> ${data.status}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:label: *Status ändrad* \`${data.ticketId}\`` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Ny status:* ${data.status}\n*Grupp:* ${data.group || '-'}\n*Gjort av:* ${data.actorEmail}` } }
    ]
  });
}

module.exports = {
  postSlack,
  notifyTicketCreated,
  notifyTicketMoved,
  notifyTicketAssigned,
  notifyTicketStatusChanged,
  isValidSlackMemberId
};
