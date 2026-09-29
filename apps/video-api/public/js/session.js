/*
 * Session kept in sessionStorage (tab scoped, cleared when the tab closes).
 * Stored shape: { token, expiresAt (epoch ms), user: { id, name, email } | null }.
 */

const STORAGE_KEY = 'fiapx.session';
const DEFAULT_TTL_SECONDS = 3600;
/** Treat the token as expired slightly early so a request never leaves with a dying token. */
const EXPIRY_SKEW_MS = 5000;

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // storage disabled (privacy settings, sandboxed frame)
  }
}

/** Reads `exp` (seconds) from the JWT payload without validating it (the API does that). */
export function jwtExpiry(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Expiry from the login response: JWT `exp` first, then `expiresIn` (seconds), then 1 h. */
export function computeExpiresAt(loginResponse, now = Date.now()) {
  const fromJwt = jwtExpiry(loginResponse?.accessToken);
  if (fromJwt) return fromJwt;
  const seconds = Number(loginResponse?.expiresIn);
  return now + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TTL_SECONDS) * 1000;
}

export function isExpired(session, now = Date.now()) {
  return !session || now >= session.expiresAt - EXPIRY_SKEW_MS;
}

export function loadSession(now = Date.now()) {
  const store = storage();
  if (!store) return null;
  try {
    const session = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null');
    if (!session || typeof session.token !== 'string' || !Number.isFinite(session.expiresAt)) {
      return null;
    }
    if (isExpired(session, now)) {
      store.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    store.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveSession(session) {
  const store = storage();
  if (store) store.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function createSession(loginResponse, now = Date.now()) {
  return saveSession({
    token: loginResponse.accessToken,
    expiresAt: computeExpiresAt(loginResponse, now),
    user: null,
  });
}

export function clearSession() {
  const store = storage();
  if (store) store.removeItem(STORAGE_KEY);
}
