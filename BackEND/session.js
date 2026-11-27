const crypto = require('node:crypto');

const COOKIE_NAME = 'byteburger_session';
const SESSION_SECONDS = 8 * 60 * 60;

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function getCookie(cookieHeader, name) {
  for (const part of (cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return '';
}

function createSessionToken(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Math.floor(now / 1000) + SESSION_SECONDS
  })).toString('base64url');
  return `${payload}.${signPayload(payload, secret)}`;
}

function verifySessionToken(token, secret, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(signPayload(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (session.role !== 'admin' || !Number.isInteger(session.exp) || session.exp <= Math.floor(now / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

function readSession(cookieHeader, secret, now) {
  if (!secret) return null;
  return verifySessionToken(getCookie(cookieHeader, COOKIE_NAME), secret, now);
}

function createSessionCookie(secret, secure = false) {
  const token = createSessionToken(secret);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure = false) {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

module.exports = {
  COOKIE_NAME,
  SESSION_SECONDS,
  createSessionCookie,
  clearSessionCookie,
  readSession,
  verifySessionToken
};
