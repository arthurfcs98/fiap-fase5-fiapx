/**
 * Mascaramento de logs (pino `redact`): segredos e dados pessoais nunca chegam ao stdout/Loki
 * (LGPD, docs/arquitetura/contratos.md, seção 12 — "Logs sem dados pessoais").
 *
 * O `redact` do pino não tem curinga recursivo: cada `*` vale exatamente um nível. Por isso cada
 * chave é declarada na raiz, um nível abaixo (`body.email`, `payload.userEmail`, `user.email`) e
 * dois níveis abaixo (`req.body.email`, `event.payload.userEmail`, `req.headers.authorization`).
 * Logs de negócio devem usar só ids (`userId`, `videoId`); isto é a rede de segurança.
 */

/** Valor gravado no lugar do dado mascarado. */
export const LOG_REDACT_CENSOR = '[REDACTED]';

/** Credenciais: mascaradas em qualquer objeto até dois níveis abaixo da raiz. */
export const SECRET_LOG_KEYS: readonly string[] = [
  'password',
  'authorization',
  'cookie',
  'token',
  'accessToken',
  'secret',
];

/**
 * Dados pessoais com nome inequívoco (seção 12): mascarados em qualquer objeto até dois níveis
 * abaixo da raiz, como os segredos.
 */
export const PERSONAL_DATA_LOG_KEYS: readonly string[] = [
  'email',
  'userEmail',
  'recipient',
  'userName',
  'originalName',
];

/**
 * `name` é genérico demais para curinga (ex.: `err.name` de um erro serializado, nome de fila
 * ou de bucket): é mascarado na raiz e nos objetos onde é o nome da pessoa, ou seja, o corpo
 * da requisição (`req.body`, `body`), o payload de um evento (`payload`, `event.payload`) e o
 * usuário (`user`, `x.user`).
 */
export const PERSONAL_NAME_CONTAINERS: readonly string[] = [
  'req.body',
  'body',
  'payload',
  '*.payload',
  'user',
  '*.user',
];

function atAnyDepth(key: string): string[] {
  return [key, `*.${key}`, `*.*.${key}`];
}

/**
 * Caminhos do `redact` do pino (usados pelo `createPinoHttpOptions` e por quem criar um pino
 * avulso). Sem caminhos sobrepostos: `req.headers.authorization` e `req.headers.cookie` já
 * caem em `*.*.authorization` e `*.*.cookie`.
 */
export const REDACTED_PATHS: readonly string[] = [
  'res.headers["set-cookie"]',
  ...SECRET_LOG_KEYS.flatMap(atAnyDepth),
  ...PERSONAL_DATA_LOG_KEYS.flatMap(atAnyDepth),
  'name',
  ...PERSONAL_NAME_CONTAINERS.map((container) => `${container}.name`),
];
