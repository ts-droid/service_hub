const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'vendora_session';

function signUser(user) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET missing');
  return jwt.sign(user, secret, { expiresIn: '7d' });
}

function verifyToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET missing');
  return jwt.verify(token, secret);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = {
  COOKIE_NAME,
  signUser,
  verifyToken,
  setSessionCookie,
  clearSessionCookie
};
