const axios = require('axios');
const db = require('./db');

async function getAiPrompt() {
  const result = await db.query('SELECT value FROM config WHERE key = $1', ['AI_PROMPT']);
  if (!result.rows[0]) return 'Skriv ett vanligt, kort och trevligt svar:';
  return result.rows[0].value;
}

async function getGeminiResponse(messageText) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY missing' };

  const systemPrompt = await getAiPrompt();
  const model = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
  const url = 'https://api.openai.com/v1/responses';
  const detectedLanguage = detectPrimaryLanguage(messageText);
  const languageRule = `CRITICAL: Reply ONLY in ${detectedLanguage}. Do not translate to another language and do not mix languages.`;

  const makePayload = (extraUserText = '') => ({
    model,
    temperature: 0.2,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'system', content: [{ type: 'input_text', text: languageRule }] },
      { role: 'user', content: [{ type: 'input_text', text: `KUNDENS MEDDELANDE:\n${messageText}${extraUserText}` }] }
    ]
  });

  try {
    let response = await axios.post(url, makePayload(), {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    });
    let text = extractOutputText(response.data);
    if (!text) return { ok: false, error: 'Empty response' };

    // One fast retry if model ignored language rule.
    if (detectPrimaryLanguage(text) !== detectedLanguage) {
      response = await axios.post(
        url,
        makePayload(`\n\nYour previous answer was not in ${detectedLanguage}. Rewrite the full email in ${detectedLanguage} only.`),
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          }
        }
      );
      text = extractOutputText(response.data);
    }
    if (!text) return { ok: false, error: 'Empty response' };
    return { ok: true, text };
  } catch (err) {
    const apiErr = err?.response?.data?.error?.message || err?.message || 'OpenAI error';
    return { ok: false, error: apiErr };
  }
}

function extractOutputText(data) {
  return (
    data?.output_text ||
    data?.output?.flatMap((item) => item?.content || [])
      ?.find((c) => c?.type === 'output_text')?.text ||
    ''
  );
}

function detectPrimaryLanguage(text) {
  const t = String(text || '').toLowerCase();
  const svHits = countHits(t, [' och ', ' att ', ' för ', ' inte ', ' med ', ' är ', ' hej ', ' vänliga ', ' hälsningar ', 'å', 'ä', 'ö']);
  const enHits = countHits(t, [' the ', ' and ', ' for ', ' not ', ' with ', ' hello ', ' regards ', ' please ', 'join us', 'thank you']);
  return svHits > enHits ? 'Swedish' : 'English';
}

function countHits(text, patterns) {
  return patterns.reduce((n, p) => n + (text.includes(p) ? 1 : 0), 0);
}

module.exports = { getGeminiResponse };
