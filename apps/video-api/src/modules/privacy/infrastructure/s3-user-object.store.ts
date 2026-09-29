import type { S3Client } from '@aws-sdk/client-s3';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { IObjectStorage } from '@fiapx/storage';
import type { UserObjectStore } from '../domain/user-object.store';

/**
 * Prefix operations the `@fiapx/storage` port does not offer yet: `ListObjectsV2` on the
 * shared `S3_CLIENT` (paginated) + one idempotent `DELETE` per object through the port. Single
 * deletes on purpose: `DeleteObjects` needs a request checksum the Garage S3 API may not accept.
 */
export class S3UserObjectStore implements UserObjectStore {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly storage: Pick<IObjectStorage, 'delete'>,
  ) {}

  async listOwnerIds(bucket: string): Promise<string[]> {
    const owners: string[] = [];
    await this.paginate(bucket, { Delimiter: '/' }, (page) => {
      for (const prefix of page.CommonPrefixes ?? []) {
        if (prefix.Prefix) owners.push(prefix.Prefix.replace(/\/$/, ''));
      }
    });
    return owners;
  }

  async deleteAllOf(bucket: string, ownerId: string): Promise<number> {
    const keys: string[] = [];
    await this.paginate(bucket, { Prefix: `${ownerId}/` }, (page) => {
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
    });
    for (const key of keys) {
      await this.storage.delete(bucket, key);
    }
    return keys.length;
  }

  private async paginate(
    bucket: string,
    params: { Prefix?: string; Delimiter?: string },
    onPage: (page: ListPage) => void,
  ): Promise<void> {
    let token: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, ...params }),
      )) as ListPage;
      onPage(page);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

interface ListPage {
  Contents?: { Key?: string }[];
  CommonPrefixes?: { Prefix?: string }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}
