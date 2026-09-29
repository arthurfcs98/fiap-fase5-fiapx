import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = 'fiapx:isPublic';

/**
 * Marks a route as public (no JWT): register, login, signed downloads, health and docs. Every
 * other route requires `Authorization: Bearer <token>` (global {@link JwtAuthGuard}).
 */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);
