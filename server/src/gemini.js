const axios = require('axios');
const db = require('./db');

async function getAiConfig() {
  const result = await db.query(
    'SELECT key, value FROM config WHERE key IN ($1, $2)',
    ['AI_PROMPT', 'AI_LANGUAGE_RULE']
  );
  const map = new Map(result.rows.map((r) => [r.key, r.value]));
  return {
    prompt: map.get('AI_PROMPT') || 'Skriv ett vanligt, kort och trevligt svar:',
    languageRuleTemplate:
      map.get('AI_LANGUAGE_RULE') ||
      'CRITICAL: Reply ONLY in {{LANGUAGE}}. Do not translate to another language and do not mix languages.'
  };
}

async function getGeminiResponse(messageText) {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY missing' };

  const aiConfig = await getAiConfig();
  const model = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
  const url = 'https://api.openai.com/v1/responses';
  const detectedLanguage = detectPrimaryLanguage(messageText);
  const languageRuleBase = aiConfig.languageRuleTemplate.includes('{{LANGUAGE}}')
    ? aiConfig.languageRuleTemplate.replace(/\{\{LANGUAGE\}\}/g, detectedLanguage)
    : `${aiConfig.languageRuleTemplate.trim()} Language: ${detectedLanguage}.`;
  const languageRule = `${languageRuleBase} Do not translate to another language and do not mix languages.`;

  const makePayload = (extraUserText = '') => ({
    model,
    temperature: 0.2,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: aiConfig.prompt }] },
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
