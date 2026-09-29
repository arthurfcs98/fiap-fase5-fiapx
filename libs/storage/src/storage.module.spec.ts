import { Test } from '@nestjs/testing';
import type { S3Client } from '@aws-sdk/client-s3';
import { OBJECT_STORAGE } from './object-storage.port';
import { S3ObjectStorage } from './s3-object-storage';
import { StorageLifecycle } from './storage-lifecycle.service';
import { StorageModule } from './storage.module';
import { S3_CLIENT, STORAGE_BUCKETS, storageOptionsFromConfig } from './storage.options';

describe('StorageModule', () => {
  it('forRootAsync provê a porta, o cliente e os buckets, e fecha o cliente no shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: () =>
            storageOptionsFromConfig({
              S3_ENDPOINT: 'http://127.0.0.1:1',
              S3_REGION: 'garage',
              S3_BUCKET_RAW: 'fiapx-raw',
              S3_BUCKET_ZIPS: 'fiapx-zips',
              S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
              S3_SECRET_ACCESS_KEY: 'z'.repeat(64),
              S3_FORCE_PATH_STYLE: true,
            }),
        }),
      ],
    }).compile();
    const app = await moduleRef.init();
    const client = app.get<S3Client>(S3_CLIENT);
    const destroy = jest.spyOn(client, 'destroy');

    expect(app.get(OBJECT_STORAGE)).toBeInstanceOf(S3ObjectStorage);
    expect(app.get(STORAGE_BUCKETS)).toEqual({ raw: 'fiapx-raw', zips: 'fiapx-zips' });
    expect(app.get(StorageLifecycle)).toBeInstanceOf(StorageLifecycle);

    await app.close();
    expect(destroy).toHaveBeenCalled();
  });
});
