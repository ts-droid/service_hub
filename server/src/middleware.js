const { DEFAULT_ALLOWED_DOMAIN } = require('./utils');
const db = require('./db');
const { COOKIE_NAME, verifyToken } = require('./auth');

async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME] || '';
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const user = verifyToken(token);
    if (!user.email || !user.email.endsWith(`@${DEFAULT_ALLOWED_DOMAIN}`)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

async function requireAdmin(req, res, next) {
  const adminList = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (adminList.includes(req.user.email)) return next();

  const result = await db.query('SELECT role FROM users WHERE email = $1', [req.user.email]);
  if (result.rows[0] && String(result.rows[0].role).toLowerCase() === 'admin') return next();

  return res.status(403).json({ error: 'forbidden' });
}

function requireJobToken(req, res, next) {
  const token = req.header('x-job-token') || '';
  if (!process.env.JOB_TOKEN || token !== process.env.JOB_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireJobToken
};
