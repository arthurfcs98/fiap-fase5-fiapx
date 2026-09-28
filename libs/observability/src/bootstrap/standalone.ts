import type { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

/**
 * Cria um serviço Nest sem HTTP público (worker, notification):
 * logger pino desde o boot (logs bufferizados até o logger existir), erros de inicialização
 * propagados (sem `process.abort()`) e graceful shutdown em SIGTERM/SIGINT.
 *
 * O módulo raiz precisa importar o `LoggerModule` do nestjs-pino.
 */
export async function createStandaloneApp(
  rootModule: Type<unknown>,
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(rootModule, {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  return app;
}

/**
 * Handler de falha no bootstrap: escreve a causa no stderr (ex.: configuração inválida
 * listada pelo zod) e encerra com código 1, para o orquestrador reiniciar/alertar.
 */
export function exitOnBootstrapError(
  serviceName: string,
  exit: (code: number) => never = (code) => process.exit(code),
): (error: unknown) => never {
  return (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[${serviceName}] falha ao iniciar: ${detail}\n`);
    return exit(1);
  };
}
