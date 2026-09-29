import { JwtService } from '@nestjs/jwt';
import { JwtAccessTokenIssuer } from './jwt-access-token.issuer';

describe('JwtAccessTokenIssuer', () => {
  it('issues an HS256 JWT with sub, iss, aud and exp (nothing personal)', async () => {
    const jwt = new JwtService();
    const secret = 's'.repeat(48);
    const issuer = new JwtAccessTokenIssuer(jwt, { secret, expiresIn: 3600 });

    const token = await issuer.issue('user-1');

    expect(token).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600 });
    const [header] = token.accessToken.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({
      alg: 'HS256',
    });
    const payload = await jwt.verifyAsync<Record<string, unknown>>(token.accessToken, { secret });
    expect(payload).toMatchObject({ sub: 'user-1', iss: 'fiapx', aud: 'fiapx-web' });
    expect(Number(payload['exp']) - Number(payload['iat'])).toBe(3600);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub']);
  });
});
