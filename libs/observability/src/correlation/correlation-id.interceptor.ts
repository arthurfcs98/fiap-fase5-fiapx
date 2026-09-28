import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  CORRELATION_ID_HEADER,
  correlationStorage,
  resolveCorrelationId,
} from './correlation-context';

interface HttpRequestLike {
  id?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface HttpResponseLike {
  headersSent?: boolean;
  setHeader(name: string, value: string): void;
}

/**
 * Interceptor HTTP (portado da Fase 3): garante um correlation id por requisição e roda o
 * handler dentro do AsyncLocalStorage, para que `getCorrelationId()` funcione em qualquer
 * camada (use cases, repositórios, outbox) sem passar o id como parâmetro.
 *
 * Reaproveita o `req.id` gerado pelo pino-http (ver `createPinoConfig`), então o id dos logs
 * de acesso, dos logs da aplicação e do header de resposta é sempre o mesmo.
 *
 * Quem abre o contexto para a requisição inteira (inclusive filtros de exceção) é o
 * `correlationIdMiddleware`; o interceptor é a segunda camada, para apps/testes que montam o
 * Nest sem o middleware.
 */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequestLike>();
    const res = http.getResponse<HttpResponseLike>();

    const correlationId = resolveCorrelationId(req.id ?? req.headers[CORRELATION_ID_HEADER]);
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    if (!res.headersSent) res.setHeader(CORRELATION_ID_HEADER, correlationId);

    // A assinatura acontece dentro do run(): toda a cadeia do handler herda o contexto.
    return new Observable((subscriber) =>
      correlationStorage.run({ correlationId }, () => next.handle().subscribe(subscriber)),
    );
  }
}
