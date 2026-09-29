/**
 * Registered user (contratos.md, sections 5 and 12). Personal data: `name`, `email` and the
 * bcrypt `passwordHash` (never the password). `privacyAcceptedAt`/`privacyPolicyVersion` record
 * the consent given at sign-up (LGPD art. 7 V and art. 9).
 */
export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  privacyAcceptedAt: Date;
  privacyPolicyVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Identity attached to an authenticated request (`req.user`). Only the id, never personal data. */
export interface AuthenticatedUser {
  id: string;
}

/** Public view of the user (`201 {id,name,email}`, `GET /api/auth/me`). */
export interface UserView {
  id: string;
  name: string;
  email: string;
}

export function toUserView(user: User): UserView {
  return { id: user.id, name: user.name, email: user.email };
}
