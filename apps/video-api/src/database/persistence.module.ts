import { Global, Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { USER_REPOSITORY } from '../modules/auth/domain/user.repository';
import { TypeOrmUserRepository } from '../modules/auth/infrastructure/persistence/typeorm-user.repository';
import { OUTBOX_STORE } from '../modules/outbox/domain/outbox.ports';
import { TypeOrmOutboxStore } from '../modules/outbox/infrastructure/typeorm-outbox.store';
import { VIDEO_REPOSITORY } from '../modules/videos/domain/video.repository';
import { TypeOrmVideoRepository } from '../modules/videos/infrastructure/persistence/typeorm-video.repository';
import { PROCESSED_MESSAGES } from '../shared/application/processed-messages';
import { UNIT_OF_WORK } from '../shared/application/unit-of-work';
import { TypeOrmProcessedMessages } from '../shared/infrastructure/database/typeorm-processed-messages';
import { TypeOrmUnitOfWork } from '../shared/infrastructure/database/typeorm-unit-of-work';

/**
 * Persistence ports bound to the TypeORM `DataSource` (global): repositories for reads outside
 * transactions, the unit of work for writes, and the relay/housekeeping stores.
 */
@Global()
@Module({
  providers: [
    {
      provide: USER_REPOSITORY,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) => new TypeOrmUserRepository(dataSource.manager),
    },
    {
      provide: VIDEO_REPOSITORY,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) => new TypeOrmVideoRepository(dataSource.manager),
    },
    {
      provide: OUTBOX_STORE,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) => new TypeOrmOutboxStore(dataSource.manager),
    },
    {
      provide: PROCESSED_MESSAGES,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) => new TypeOrmProcessedMessages(dataSource.manager),
    },
    {
      provide: UNIT_OF_WORK,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) => new TypeOrmUnitOfWork(dataSource),
    },
  ],
  exports: [USER_REPOSITORY, VIDEO_REPOSITORY, OUTBOX_STORE, PROCESSED_MESSAGES, UNIT_OF_WORK],
})
export class PersistenceModule {}
