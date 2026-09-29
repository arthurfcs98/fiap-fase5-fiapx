import type { S3Client } from '@aws-sdk/client-s3';
import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { IObjectStorage } from '@fiapx/storage';
import type { StoredObjectInfo, UserObjectStore } from '../domain/user-object.store';

/**
 * Bucket operations the `@fiapx/storage` port does not offer: `ListObjectsV2` and
 * `ListMultipartUploads` on the shared `S3_CLIENT` (paginated) + one idempotent `DELETE` per
 * object through the port. Single deletes on purpose: `DeleteObjects` needs a request checksum
 * the Garage S3 API may not accept.
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

  async listObjects(bucket: string): Promise<StoredObjectInfo[]> {
    const objects: StoredObjectInfo[] = [];
    await this.paginate(bucket, {}, (page) => {
      for (const object of page.Contents ?? []) {
        if (object.Key) objects.push({ key: object.Key, lastModified: object.LastModified });
      }
    });
    return objects;
  }

  async abortIncompleteUploads(bucket: string, initiatedBefore: Date): Promise<number> {
    let aborted = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = (await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      )) as UploadsPage;
      for (const upload of page.Uploads ?? []) {
        if (!upload.Key || !upload.UploadId) continue;
        if (upload.Initiated && upload.Initiated >= initiatedBefore) continue;
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.Key,
            UploadId: upload.UploadId,
          }),
        );
        aborted += 1;
      }
      const more = page.IsTruncated === true;
      keyMarker = more ? page.NextKeyMarker : undefined;
      uploadIdMarker = more ? page.NextUploadIdMarker : undefined;
    } while (keyMarker);
    return aborted;
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
  Contents?: { Key?: string; LastModified?: Date }[];
  CommonPrefixes?: { Prefix?: string }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

interface UploadsPage {
  Uploads?: { Key?: string; UploadId?: string; Initiated?: Date }[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextUploadIdMarker?: string;
}
