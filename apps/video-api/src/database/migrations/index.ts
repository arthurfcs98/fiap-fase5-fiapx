import { Init1790553600000 } from './1790553600000-init';
import { StatusHistoryIndex1790640000000 } from './1790640000000-status-history-index';

/**
 * EXPLICIT migration list (no glob: the webpack bundle cannot load files by path pattern and
 * the order stays visible). A new migration is appended here in the same PR.
 */
export const MIGRATIONS = [Init1790553600000, StatusHistoryIndex1790640000000];
