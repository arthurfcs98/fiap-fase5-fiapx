import { z } from 'zod';
import { eventEnvelopeSchema } from '../envelope';
import { EVENT_TYPES } from './event-types';

/**
 * video-api (outbox, na transação do `DELETE /api/me`) → notification-service, que anonimiza as
 * notificações daquele usuário (contratos.md, seção 12 — "Propagação da eliminação").
 *
 * Só o id: o evento existe justamente porque os dados pessoais foram apagados. O publicador
 * publica o envelope já validado, então campos a mais no payload são descartados antes do envio.
 */
export const userDeletedPayload = z.object({
  userId: z.uuid(),
});

export const userDeletedEvent = eventEnvelopeSchema(EVENT_TYPES.userDeleted, userDeletedPayload);

export type UserDeletedEvent = z.infer<typeof userDeletedEvent>;
