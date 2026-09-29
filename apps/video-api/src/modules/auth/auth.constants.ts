/** bcrypt cost (contratos.md, section 12 — "Segurança"). */
export const BCRYPT_COST = 12;

/** JWT claims checked on every request (HS256 only). */
export const JWT_ISSUER = 'fiapx';
export const JWT_AUDIENCE = 'fiapx-web';
export const JWT_ALGORITHM = 'HS256';

/** Passport strategy name. */
export const JWT_STRATEGY = 'jwt';
