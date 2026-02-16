const axios = require('axios');
const db = require('./db');

async function getAiPrompt() {
  const result = await db.query('SELECT value FROM config WHERE key = $1', ['AI_PROMPT']);
  if (!result.rows[0]) return 'Skriv ett vanligt, kort och trevligt svar:';
  return result.rows[0].value;
}

async function getGeminiResponse(messageText) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'API key missing' };

  const systemPrompt = await getAiPrompt();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: `${systemPrompt}\n\nKUNDENS MEDDELANDE:\n${messageText}` }] }]
  };

  try {
    const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, error: 'Empty response' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: 'Gemini error' };
  }
}

module.exports = { getGeminiResponse };
