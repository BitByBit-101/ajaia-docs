'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'sid';

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(userId, secret) {
  return `${userId}.${sign(userId, secret)}`;
}

/** Returns the userId if the token signature is valid, otherwise null. */
function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(userId, secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return userId;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // ignore malformed cookie values
    }
  }
  return out;
}

module.exports = { COOKIE_NAME, makeToken, verifyToken, parseCookies };
