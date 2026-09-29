import { Init1790553600000 } from './1790553600000-Init';
import { DeletedUsers1790640000000 } from './1790640000000-DeletedUsers';

/**
 * Every migration of `fiapx_notification`, in order. Explicit list (no glob): the webpack bundle
 * cannot load files by path pattern. `migrations.spec.ts` fails if a file is left out.
 */
export const NOTIFICATION_MIGRATIONS = [Init1790553600000, DeletedUsers1790640000000];
