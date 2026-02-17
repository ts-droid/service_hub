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
  const payload = {
    model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'user', content: [{ type: 'input_text', text: `KUNDENS MEDDELANDE:\n${messageText}` }] }
    ]
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      }
    });
    const text =
      response.data?.output_text ||
      response.data?.output?.flatMap((item) => item?.content || [])
        ?.find((c) => c?.type === 'output_text')?.text ||
      '';
    if (!text) return { ok: false, error: 'Empty response' };
    return { ok: true, text };
  } catch (err) {
    const apiErr = err?.response?.data?.error?.message || err?.message || 'OpenAI error';
    return { ok: false, error: apiErr };
  }
}

module.exports = { getGeminiResponse };
