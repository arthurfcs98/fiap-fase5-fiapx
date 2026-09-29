import { ZodValidationPipe } from '@fiapx/common';
import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { BEARER_AUTH } from '../../../../shared/interfaces/http.constants';
import { ThrottleBy } from '../../../../shared/infrastructure/throttling/throttle';
import { GetProfileUseCase } from '../../application/use-cases/get-profile.use-case';
import { LoginUseCase } from '../../application/use-cases/login.use-case';
import { RegisterUserUseCase } from '../../application/use-cases/register-user.use-case';
import type { AccessToken } from '../../domain/access-token.port';
import type { AuthenticatedUser, UserView } from '../../domain/user';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import type { LoginRequest, RegisterRequest } from '../dto/auth.dto';
import {
  AccessTokenResponseDto,
  LoginRequestDto,
  loginSchema,
  RegisterRequestDto,
  registerSchema,
  UserResponseDto,
} from '../dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUserUseCase,
    private readonly login: LoginUseCase,
    private readonly getProfile: GetProfileUseCase,
  ) {}

  @Post('register')
  @Public()
  @ThrottleBy('register')
  @ApiOperation({
    summary: 'Cadastro (exige aceite da política de privacidade)',
    description: 'Sem `acceptPrivacyPolicy: true` → 400 X0001. E-mail já cadastrado → 409 A0002.',
  })
  @ApiBody({ type: RegisterRequestDto })
  @ApiCreatedResponse({ type: UserResponseDto })
  @ApiConflictResponse({ description: 'A0002 EMAIL_ALREADY_REGISTERED' })
  @ApiTooManyRequestsResponse({ description: 'X0429 (Retry-After)' })
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterRequest): Promise<UserView> {
    return this.registerUser.execute(body);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ThrottleBy('login')
  @ApiOperation({ summary: 'Login (5 tentativas por minuto por IP + e-mail)' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: AccessTokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'A0001 INVALID_CREDENTIALS' })
  @ApiTooManyRequestsResponse({ description: 'X0429 (Retry-After)' })
  authenticate(@Body(new ZodValidationPipe(loginSchema)) body: LoginRequest): Promise<AccessToken> {
    return this.login.execute(body);
  }

  @Get('me')
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Usuário autenticado' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'A0003 UNAUTHORIZED' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.getProfile.execute(user.id);
  }
}
