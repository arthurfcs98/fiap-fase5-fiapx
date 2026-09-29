/** `POST /api/auth/login` response body (contratos.md, section 8). */
export interface AccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  /** Lifetime in seconds. */
  expiresIn: number;
}

/** Issues the signed access token (JWT HS256) for an authenticated user id. */
export interface AccessTokenIssuer {
  issue(userId: string): Promise<AccessToken>;
}

export const ACCESS_TOKEN_ISSUER = Symbol('ACCESS_TOKEN_ISSUER');
