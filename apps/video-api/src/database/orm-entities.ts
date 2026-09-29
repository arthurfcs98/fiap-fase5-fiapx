import { UserOrmEntity } from '../modules/auth/infrastructure/persistence/user.orm-entity';
import { VideoStatusHistoryOrmEntity } from '../modules/videos/infrastructure/persistence/video-status-history.orm-entity';
import { VideoOrmEntity } from '../modules/videos/infrastructure/persistence/video.orm-entity';

/**
 * Mapped tables. `outbox_events` and `processed_messages` are accessed with explicit SQL
 * (`FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO NOTHING`), so they have no entity.
 */
export const ORM_ENTITIES = [UserOrmEntity, VideoOrmEntity, VideoStatusHistoryOrmEntity];
