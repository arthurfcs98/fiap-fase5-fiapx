import { randomUUID } from 'node:crypto';
import { ZodValidationPipe } from '@fiapx/common';
import { getCorrelationId } from '@fiapx/observability';
import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottleBy } from '../../../../shared/infrastructure/throttling/throttle';
import { BEARER_AUTH } from '../../../../shared/interfaces/http.constants';
import type { AuthenticatedUser } from '../../../auth/domain/user';
import { CurrentUser } from '../../../auth/interfaces/decorators/current-user.decorator';
import { DeleteMyAccountUseCase } from '../../application/use-cases/delete-my-account.use-case';
import type { MyDataExport } from '../../application/use-cases/export-my-data.use-case';
import { ExportMyDataUseCase } from '../../application/use-cases/export-my-data.use-case';
import type { DeleteAccountRequest } from '../dto/privacy.dto';
import { DeleteAccountRequestDto, deleteAccountSchema } from '../dto/privacy.dto';

/** Name of the data export file (the frontend adds the date to its own copy). */
export const EXPORT_FILE_NAME = 'fiap-frames-meus-dados.json';

/** Data subject rights (LGPD art. 18, contratos.md section 12). */
@ApiTags('privacidade (LGPD)')
@ApiBearerAuth(BEARER_AUTH)
@Controller('me')
export class MeController {
  constructor(
    private readonly exportMyData: ExportMyDataUseCase,
    private readonly deleteMyAccount: DeleteMyAccountUseCase,
  ) {}

  @Get('data')
  @Header('Cache-Control', 'no-store')
  // Brand visible to the user (contratos.md, section 14): "FIAP Frames", as the frontend does.
  @Header('Content-Disposition', `attachment; filename="${EXPORT_FILE_NAME}"`)
  @ApiOperation({
    summary: 'Acesso e portabilidade: exporta todos os meus dados (JSON)',
    description: 'Usuário (sem o hash da senha), todos os vídeos e o histórico de status.',
  })
  @ApiOkResponse({ description: 'JSON com user, videos[] e history[] de cada vídeo' })
  @ApiUnauthorizedResponse({ description: 'A0003 UNAUTHORIZED' })
  data(@CurrentUser() user: AuthenticatedUser): Promise<MyDataExport> {
    return this.exportMyData.execute(user.id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ThrottleBy('accountDeletion')
  @ApiOperation({
    summary: 'Eliminação: apaga minha conta, vídeos, histórico e arquivos',
    description:
      'Confirmação pela senha. Os tokens emitidos antes deixam de valer. As notificações ' +
      'enviadas são anonimizadas pelo notification-service (evento user.deleted).',
  })
  @ApiBody({ type: DeleteAccountRequestDto })
  @ApiNoContentResponse({ description: 'Conta eliminada' })
  @ApiBadRequestResponse({ description: 'A0004 INVALID_PASSWORD_CONFIRMATION · X0001 VALIDATION' })
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(deleteAccountSchema)) body: DeleteAccountRequest,
  ): Promise<void> {
    await this.deleteMyAccount.execute({
      userId: user.id,
      password: body.password,
      correlationId: getCorrelationId() ?? randomUUID(),
    });
  }
}
