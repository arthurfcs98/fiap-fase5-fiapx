# ADR-0010: LGPD desde o desenho

- Status: aceita
- Data: 2026-09-28

## Contexto

O sistema trata dados pessoais: nome, e-mail, hash da senha, o nome original do arquivo, o
destinatário dos e-mails e, principalmente, o **conteúdo dos vídeos**, que pode mostrar pessoas.
A LGPD (Lei 13.709/2018) exige base legal, transparência, minimização, prazo de retenção,
direitos do titular (acesso, portabilidade, eliminação), segurança e um procedimento para
incidentes. Logs e filas são caminhos comuns de vazamento.

## Decisão

- **Base legal e transparência**: cadastro exige `acceptPrivacyPolicy: true` e grava a data e a
  versão da política aceita; página pública `/privacidade.html`.
- **Minimização**: só nome, e-mail, hash bcrypt da senha e o vídeo; o nome do arquivo nunca vira
  caminho no storage (as chaves só têm UUIDs).
- **Retenção**:
  - vídeo original apagado quando o processamento termina (COMPLETED **ou** FAILED), com rede
    de segurança no job de hora em hora (originais que sobraram e uploads multipart
    interrompidos também são apagados);
  - zip por 7 dias (`ZIP_RETENTION_DAYS`), apagado por um job de hora em hora que roda em uma
    réplica por vez (`pg_try_advisory_xact_lock`); depois, o download responde `410 V0006`;
  - linhas publicadas do outbox (têm e-mail e nome) apagadas em 7 dias; inbox em 14 dias;
    varredura de objetos de usuários que não existem mais;
  - notificações anonimizadas em 30 dias (`recipient = 'removido'`, `payload = '{}'`);
  - logs por 72 h e métricas por 3 dias, sem dado pessoal.
- **Direitos do titular**: `GET /api/me/data` (acesso e portabilidade, JSON) e `DELETE /api/me`
  com confirmação de senha (eliminação numa transação, evento `user.deleted` para o
  `notification-service` anonimizar as notificações, e objetos apagados nos dois buckets). O
  notificador guarda só o id do usuário eliminado (`deleted_users`), para que um evento atrasado
  dele não volte a gravar e-mail nem nome.
- **Filas**: as DLQs guardam envelopes com e-mail, nome e nome de arquivo; uma operator policy do
  RabbitMQ as limita a 7 dias.
- **E-mail sem abuso**: o cadastro não verifica o e-mail, então em produção só a falha gera
  e-mail, há um orçamento diário (por usuário e total) e nome e nome de arquivo nunca viram link.
- **Logs sem dados pessoais**: redação no pino (`password`, `authorization`, `email`, `name`,
  `originalName`...), log de acesso sem query string e sem cabeçalhos, Postgres com
  `log_error_verbosity=terse`, logs de negócio só com IDs e métricas sem rótulo pessoal.
- **Verificação automática**: o último cenário BDD lê os logs de **todos** os containers e falha
  se aparecer e-mail, nome, nome de arquivo ou link assinado.
- **Incidentes**: runbook com identificação, contenção, avaliação e comunicação.

## Consequências

**Positivas (+)**

- Conformidade por construção e testada (BDD de privacidade, retenção e logs; E2E; integração).
- Menos dado guardado = menos risco e disco limitado.
- A eliminação alcança todos os serviços pelo mesmo mecanismo de eventos do resto do sistema.

**Negativas (−)**

- Mais jobs e caminhos de código (retenção, limpeza, anonimização).
- O usuário precisa baixar o zip em até 7 dias; não há reprocessamento (o original é apagado).
- Logs menos ricos para depuração (só IDs); o `correlationId` compensa.
- A anonimização das notificações é assíncrona (via evento) e a limpeza dos objetos tem uma
  varredura de segurança se o storage estiver fora no momento da eliminação.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| Guardar tudo por tempo indeterminado | risco e disco sem justificativa de finalidade |
| Exclusão lógica (soft delete) da conta | mantém dado pessoal que o titular pediu para eliminar |
| Mascarar os logs depois, no coletor | o dado já teria saído do processo |
| Criptografar cada vídeo com chave por usuário | complexidade alta; bucket privado + retenção curta atendem ao risco |

## Onde está

- [`docs/lgpd.md`](../lgpd.md) (mapa de dados, bases legais, retenção, direitos, evidências)
- `apps/video-api/src/modules/privacy/` e `apps/video-api/public/privacidade.html`
- `apps/notification-service/src/modules/notifications/application/use-cases/anonymize-user-notifications.use-case.ts` e `apply-notification-retention.use-case.ts`
- `libs/observability/src/logging/redaction.ts` e `pino.config.ts`
- `tests/bdd/features/05-privacidade.feature`, `06-retencao.feature`, `99-logs-sem-dados-pessoais.feature`
- [`docs/runbooks/incidente-dados.md`](../runbooks/incidente-dados.md)
