/** One-way password hashing (bcrypt cost 12 in production). */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
  /**
   * A valid hash, at the same cost as real ones, of a random value that nobody knows (generated at
   * runtime, never stored). Login compares unknown e-mails against it so the response time does
   * not reveal whether the e-mail is registered.
   */
  timingEqualizerHash(): Promise<string>;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
