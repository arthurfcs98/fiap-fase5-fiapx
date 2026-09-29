import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { ApiConfig } from '../../config/api.config';
import { API_CONFIG } from '../../config/api.config';
import { AUTH_SETTINGS, authSettingsFromConfig } from './application/auth.settings';
import { GetProfileUseCase } from './application/use-cases/get-profile.use-case';
import { LoginUseCase } from './application/use-cases/login.use-case';
import { RegisterUserUseCase } from './application/use-cases/register-user.use-case';
import { ACCESS_TOKEN_ISSUER } from './domain/access-token.port';
import { PASSWORD_HASHER } from './domain/password-hasher.port';
import { BcryptPasswordHasher } from './infrastructure/security/bcrypt-password-hasher';
import { JwtAccessTokenIssuer } from './infrastructure/security/jwt-access-token.issuer';
import { JwtStrategy } from './infrastructure/security/jwt.strategy';
import { AuthController } from './interfaces/controllers/auth.controller';
import { JwtAuthGuard } from './interfaces/guards/jwt-auth.guard';

/**
 * Sign-up, login and profile. Registers the GLOBAL JWT guard: every route needs a Bearer token
 * unless it is `@Public()`. The user repository comes from the global persistence module.
 */
@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_SETTINGS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => authSettingsFromConfig(config),
    },
    { provide: PASSWORD_HASHER, useFactory: () => new BcryptPasswordHasher() },
    {
      provide: ACCESS_TOKEN_ISSUER,
      inject: [JwtService, API_CONFIG],
      useFactory: (jwt: JwtService, config: ApiConfig) =>
        new JwtAccessTokenIssuer(jwt, {
          secret: config.JWT_SECRET,
          expiresIn: config.JWT_EXPIRES_IN,
        }),
    },
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    RegisterUserUseCase,
    LoginUseCase,
    GetProfileUseCase,
  ],
  exports: [PASSWORD_HASHER],
})
export class AuthModule {}
